/**
 * The renderer's own assertions, kept out of `tools/playtest.mjs` because that
 * file is about the *game* — waves, shields, docking, the war — and this is
 * about the machine drawing it. Same harness, same `check`, same page; a
 * separate file only so neither has to be read to work on the other.
 *
 * Every block here is an exported `async ({ page, check }) => {}` and
 * `playtest.mjs` calls them in the order its own narrative wants. They take the
 * live `check` rather than returning results so a failure is reported at the
 * moment it happens, interleaved with the game's own log, the way every other
 * assertion in this suite is.
 *
 * ## The hole this file exists to close, and how far it actually closes it
 *
 * The harness runs headless Chromium on SwiftShader — software GL, forced by
 * `launchOptions`' own `--use-angle=swiftshader`, and mandatory in the Linux CI
 * container that has no GPU at all. Two of the newest systems detect exactly
 * that and deliberately fall back:
 *
 *  - `mediaQuality()` (`src/render/shaders/media.ts`) probes the GL renderer
 *    string and returns 0, so `Comet` and `Shoals` build no volume and keep
 *    their old `TraceBuffer` filaments.
 *  - `Nebula.checkRenderer` matches the same name list and sets `disabled`, so
 *    the six-face volumetric bake never runs.
 *
 * So a suite that only ever *observes* is a suite that validates the fallback
 * renderer — the one no player will ever run. Four ways out were weighed:
 *
 *  1. **Assert the fallback is correctly selected.** Cheap and honest, and it
 *     is not nothing — a build where `mediaQuality` refuses and `Nebula` does
 *     not (or the reverse) is a half-fallback nobody has ever run, and that is
 *     a real regression this catches. But on its own it validates a guard, not
 *     a renderer. **Kept, as part of the answer, not as the answer.**
 *  2. **Force the real path on and accept slow frames.** Kept for the media,
 *     rejected for the nebula, and the difference is arithmetic rather than
 *     taste. `__media.setQuality(1)` is ungated on every host precisely so a
 *     bench can do this, and — this is the part that makes it free — a
 *     `MediaVolume` built while its owner's scene node is invisible costs
 *     *nothing*: the material is not compiled until a fragment is rasterised,
 *     and `__scenery.hide()` has already made sure none ever is. Everything
 *     that can be wrong in the medium's CPU half (the proxy's transform, the
 *     key light, the uniform set, the injected-light ranking) is then asserted
 *     on the exact code a player runs. The nebula has no equivalent: its only
 *     forcing lever is `__nebula.measure()`, which runs the *whole* queue —
 *     6 preview faces at 192² and 52 march steps, then 24 tiles at 512² and 84
 *     steps, order 5e8 shader steps. On a software rasteriser that is not a
 *     slow test, it is a hang, and `Nebula.ts`'s own header says so. See the
 *     probe request in this task's report for the one-line addition that would
 *     make a single preview face measurable.
 *  3. **Assert on CPU-side state that is identical either way.** Used
 *     everywhere it applies, because it is strictly the best of the four when
 *     it applies: the nebula's plan and `aim()`, the rock field's world-space
 *     list, the post chain's shape, the hulls' albedo derivation and the frame
 *     cap are all the same numbers on a GPU and on SwiftShader.
 *  4. **A second browser context with different flags.** Rejected. It would
 *     work on the Mac this was written on, where ANGLE can reach Metal, and
 *     fail in the container `launchOptions` was written for, which pins
 *     `/opt/pw-browsers/chromium` and has no GPU. A suite that passes locally
 *     and cannot run in CI is the same defect this file exists to fix, pointed
 *     the other way.
 *
 * What remains genuinely uncovered, said plainly rather than left to be
 * discovered: **no fragment of either volumetric shader is ever compiled or
 * executed by this suite.** A GLSL error in the march, the bounds hull or the
 * nebula's bake would not fail here. That needs either a GPU runner or the
 * preview-face probe named above.
 */

/**
 * three's own `NoToneMapping`. Written out rather than imported because this
 * file never loads three in node — everything here runs in the page.
 */
const NO_TONE_MAPPING = 0;

/**
 * ## One rule for every `import()` in this file
 *
 * **Reach module *state* through a `window.__*` handle; import a module only
 * for pure functions and constants.**
 *
 * Vite serves an edited module at a cache-busted URL — the app's own graph
 * carries `/src/render/shaders/media.ts?t=1787101051458` once anything has
 * touched that file since the dev server started — and a harness importing the
 * bare `/src/render/shaders/media.ts` gets a *second instance* with its own
 * module-level state. That cost an hour here: `__media.setQuality(1)` moved the
 * `probed` cache in the harness's copy while `Shoals` went on reading the app's,
 * and the forced real path silently kept building strokes with every visible
 * signal saying it should not.
 *
 * Importing a module the app *also* imports is still safe, because the served
 * source carries the same `?t=` and resolves to the same record; it is only the
 * hand-written bare URL that forks. The rule above avoids having to know which
 * case you are in.
 */


/** The occluder night side every hull in the game is built to land on. */
const NIGHT_SIDE = "060a0f";

/**
 * Linear -> sRGB, the same OETF `ToneMapPass` writes out and `Color.setHex`
 * inverts on the way in. Used to check a derived colour against the hex a
 * source file names, which is the form the decision was recorded in.
 */
function toSrgbByte(linear) {
  const v = Math.max(0, linear);
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, s) * 255);
}

const hex3 = (r, g, b) =>
  [r, g, b].map((c) => toSrgbByte(c).toString(16).padStart(2, "0")).join("");

// ── the guard itself ────────────────────────────────────────────────────────

/**
 * Part 1 of the SwiftShader answer: prove the fallback is selected, and
 * selected for the *right reason*, and selected by both systems together.
 *
 * The last of those is the one worth having. Two independent files match two
 * independently-maintained regexes against the same renderer string, and a
 * build where one refuses and the other does not is a configuration no
 * developer and no player has ever run — a volumetric nebula baking behind a
 * comet drawn as strokes, or the reverse. Nothing else in this suite would
 * notice.
 */
export async function checkRendererGuards({ page, check }) {
  const guard = await page.evaluate(() => {
    const gl = window.__stage.renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(
      (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "",
    );
    return {
      renderer: name,
      software: /swiftshader|llvmpipe|software|mesa offscreen|basic render|paravirtual/i.test(name),
      mediaQuality: window.__media.quality(),
      nebula: window.__nebula.state(),
    };
  });
  check(
    "the harness really is on the software rasteriser it plans around",
    guard.software === true,
    guard.renderer,
  );
  check(
    "...so the volumetric media refuse to march and keep their strokes",
    guard.mediaQuality === 0,
    `quality=${guard.mediaQuality}`,
  );
  check(
    "...and the nebula refuses to bake",
    guard.nebula.disabled === true,
    JSON.stringify(guard.nebula),
  );
  // The refusal has to be total, not merely reported. A `disabled` flag that
  // still let the queue run would be the worst of both.
  check(
    "...with no bake work queued behind the refusal",
    guard.nebula.progress === 0 && guard.nebula.previewReady === false && guard.nebula.fullReady === false,
    JSON.stringify(guard.nebula),
  );
  // The one that no other check in this suite could catch: two regexes, two
  // files, one machine. They must agree.
  check(
    "the two independent software-GL guards agree with each other",
    (guard.mediaQuality === 0) === (guard.nebula.disabled === true),
    `media=${guard.mediaQuality} nebulaDisabled=${guard.nebula.disabled}`,
  );
}

// ── lit hulls ───────────────────────────────────────────────────────────────

/**
 * The latent coupling `render/light.ts` names in its own header: three.js
 * resolves a Lambert surface to `albedo * (ambient + dotNL * directional) / PI`,
 * so the night side of every hull is `albedo * ambient / PI`, and
 * `VectorObject`'s constructor inverts exactly that to turn a caller's
 * requested occluder colour into an albedo.
 *
 * **The ambient is read off the scene, not off `RIG`.** Reading `RIG.ambient`
 * and dividing by it again would be an arithmetic identity — the test could not
 * fail. What can actually break is the *scene* and the *derivation* drifting
 * apart: `main.ts` builds the `AmbientLight` from `RIG`, `VectorObject` builds
 * `AMBIENT_DIFFUSE` from `RIG`, and either could be given a hand-written number
 * again (which is how `VectorObject` shipped the first time). Standing the
 * light the game actually rendered against the albedo the game actually built
 * is the only form of this check that has something to say.
 */
export async function checkLitHulls({ page, check }) {
  const lit = await page.evaluate(async () => {
    const { VectorObject } = await import("/src/render/VectorObject.ts");
    const { buildCruiser } = await import("/src/geometry/hulls.ts");
    const { RIG } = await import("/src/render/light.ts");

    // What the game actually stood up, found by walking the scene rather than
    // by trusting the constant either file was built from.
    let ambient = null;
    let ambientCount = 0;
    let directional = null;
    let directionalCount = 0;
    window.__stage.scene.traverse((o) => {
      if (o.isAmbientLight) {
        ambient = o.intensity;
        ambientCount++;
      }
      if (o.isDirectionalLight) {
        directional = o.intensity;
        directionalCount++;
      }
    });

    const object = new VectorObject(buildCruiser());
    const material = object.hull.material;
    const albedo = material.color;
    // `LineSegments2` reports `isMesh === true` — it really is a mesh of quads
    // standing in for fat lines — so the fill has to be identified as the
    // object's own `hull`, not by `isMesh`.
    const strokes = object.group.children.filter((c) => c.isLineSegments2 || c.isLine2);
    const fills = object.group.children.filter((c) => c === object.hull);
    const shape = {
      children: object.group.children.length,
      strokes: strokes.length,
      fills: fills.length,
      strokeLit: strokes.some((s) => s.material.lights === true),
    };
    shape.onlyTwo = object.group.children.length === strokes.length + fills.length;
    object.dispose?.();

    return {
      ambient,
      ambientCount,
      directional,
      directionalCount,
      rig: { ambient: RIG.ambient, directional: RIG.directional },
      albedo: { r: albedo.r, g: albedo.g, b: albedo.b },
      lambert: material.isMeshLambertMaterial === true,
      standard: material.isMeshStandardMaterial === true,
      flat: material.flatShading === true,
      shape,
    };
  });

  check(
    "the sector stands up exactly one ambient and one directional light",
    lit.ambientCount === 1 && lit.directionalCount === 1,
    `ambient=${lit.ambientCount} directional=${lit.directionalCount}`,
  );
  check(
    "...at the intensities RIG names, so no second copy of them has drifted",
    lit.ambient === lit.rig.ambient && lit.directional === lit.rig.directional,
    `scene=${lit.ambient}/${lit.directional} RIG=${lit.rig.ambient}/${lit.rig.directional}`,
  );
  // A hull is a lit fill plus unlit strokes, and the strokes must stay unlit —
  // a `LineMaterial` that started answering the star would put a terminator on
  // the edges, which is the one thing "occluded geometry, not pure wireframe"
  // does not mean.
  check(
    "a hull is one lit fill and one unlit stroke set",
    lit.shape.fills === 1 && lit.shape.strokes === 1 && lit.shape.strokeLit === false && lit.shape.onlyTwo,
    JSON.stringify(lit.shape),
  );
  check(
    "the fill is Lambert and flat-shaded, not Standard",
    lit.lambert && lit.flat && !lit.standard,
    `lambert=${lit.lambert} flat=${lit.flat} standard=${lit.standard}`,
  );

  // The coupling itself. `albedo * ambient / PI`, in linear working space,
  // encoded to sRGB the way the output pass will, has to land on the hex the
  // decision was written down as.
  const k = lit.ambient / Math.PI;
  const night = hex3(lit.albedo.r * k, lit.albedo.g * k, lit.albedo.b * k);
  check(
    "the hull's night side lands on the occluder colour the file names, to the byte",
    night === NIGHT_SIDE,
    `#${night}, wanted #${NIGHT_SIDE} (ambient=${lit.ambient})`,
  );
  // The other end of the same derivation, and the reason it is safe to light
  // hulls at all: the brightest a fill can reach must stay under the bloom
  // threshold, or a lit face starts competing with the strokes it sits behind.
  const fullLit = (lit.ambient + lit.directional) / Math.PI;
  const brightest = Math.max(lit.albedo.r, lit.albedo.g, lit.albedo.b) * fullLit;
  check(
    "...and the brightest a fill can reach still cannot bloom",
    brightest < 0.5,
    `peak=${brightest.toFixed(4)} linear, bloom threshold 0.5`,
  );
}

// ── the event-light pool ────────────────────────────────────────────────────

/**
 * `render/eventLights.ts` is a fixed pool of eight `PointLight`s whose
 * *intensity* is animated, because adding a light to a three.js scene
 * invalidates every lit material's program — measured at 170 ms in one frame.
 * The pool never growing is therefore not an implementation detail, it is the
 * feature; and it is invisible on screen, because a ninth light would look
 * exactly right and merely cost a hitch.
 *
 * Everything here runs inside single `evaluate` calls where the assertion is
 * about a *moment*, so no frame — and therefore no `update`, no decay, no
 * eviction — can land in the middle of a measurement.
 */
export async function checkEventLightPool({ page, check }) {
  const pool = await page.evaluate(async () => {
    const { EVENT_LIGHT, CURVES } = await import("/src/render/eventLights.ts");
    const { PALETTE } = await import("/src/render/palette.ts");
    const lights = window.__eventLights;
    lights.clear();

    const at = (x) => window.__player.position.clone().set(x, 0, 0);
    const colour = PALETTE.trace.clone();
    const before = {
      slots: lights.inspect().length,
      children: lights.group.children.length,
      lit: lights.inspect().filter((s) => s.intensity > 0).length,
    };

    // One flash, read in the same tick it was armed.
    lights.flash(at(0), colour, 4, 1, { curve: CURVES.steady });
    const oneFlash = lights.inspect();

    // More flashes than there are slots. A pool that grew would answer 20.
    for (let i = 0; i < 20; i++) lights.flash(at(i), colour, 4, 1, { curve: CURVES.steady });
    const oversubscribed = {
      slots: lights.inspect().length,
      children: lights.group.children.length,
      lit: lights.inspect().filter((s) => s.intensity > 0).length,
    };

    lights.clear();
    const cleared = lights.inspect();

    return {
      count: EVENT_LIGHT.count,
      before,
      oneFlashLit: oneFlash.filter((s) => s.intensity > 0).length,
      oneFlashPeak: Math.max(...oneFlash.map((s) => s.intensity)),
      oneFlashRemaining: Math.max(...oneFlash.map((s) => s.remaining)),
      oversubscribed,
      clearedLit: cleared.filter((s) => s.intensity > 0).length,
      clearedSlots: cleared.length,
      clearedChildren: lights.group.children.length,
    };
  });

  check(
    "the event-light pool is the fixed size its constant names",
    pool.before.slots === pool.count && pool.before.children === pool.count,
    `slots=${pool.before.slots} children=${pool.before.children} count=${pool.count}`,
  );
  check("...and starts dark", pool.before.lit === 0, `lit=${pool.before.lit}`);
  check(
    "a flash actually raises an intensity",
    pool.oneFlashLit === 1 && pool.oneFlashPeak > 0,
    `lit=${pool.oneFlashLit} peak=${pool.oneFlashPeak}`,
  );
  check(
    "...on a slot with time left to run",
    pool.oneFlashRemaining > 0,
    `remaining=${pool.oneFlashRemaining}`,
  );
  // The whole point of the file, in one line: twenty flashes, eight lights.
  check(
    "twenty flashes do not grow the pool past its eight slots",
    pool.oversubscribed.slots === pool.count &&
      pool.oversubscribed.children === pool.count &&
      pool.oversubscribed.lit === pool.count,
    JSON.stringify(pool.oversubscribed),
  );
  check(
    "clear() empties every slot",
    pool.clearedLit === 0,
    `lit=${pool.clearedLit}`,
  );
  check(
    "...without touching the pool's size, so it costs no recompile",
    pool.clearedSlots === pool.count && pool.clearedChildren === pool.count,
    `slots=${pool.clearedSlots} children=${pool.clearedChildren}`,
  );

  // Decay is the one property that needs real frames, since it is `dt`-driven.
  // Polled rather than slept for the reason `waitFor`'s own header gives.
  await page.evaluate(async () => {
    const { CURVES } = await import("/src/render/eventLights.ts");
    const { PALETTE } = await import("/src/render/palette.ts");
    window.__eventLights.clear();
    window.__eventLights.flash(
      window.__player.position.clone().set(0, 0, 0),
      PALETTE.trace.clone(),
      6,
      0.6,
      { curve: CURVES.steady },
    );
  });
  const peak = await page.evaluate(() =>
    Math.max(...window.__eventLights.inspect().map((s) => s.intensity)),
  );
  const deadline = Date.now() + 6000;
  let now = peak;
  while (now > 0 && Date.now() < deadline) {
    await page.waitForTimeout(80);
    now = await page.evaluate(() =>
      Math.max(...window.__eventLights.inspect().map((s) => s.intensity)),
    );
  }
  check(
    "a flash decays back to nothing on its own clock",
    peak > 0 && now === 0,
    `peak=${peak} now=${now}`,
  );
  await page.evaluate(() => window.__eventLights.clear());
}

/**
 * The integration half: something the *game* did lit the pool, rather than the
 * harness calling `flash` by hand. Called mid-combat, where torpedo
 * detonations, phaser impacts and shield hits are all live.
 *
 * Sampled over a window rather than at an instant, because a spike curve is
 * mostly over within a few hundred milliseconds and a single poll would be a
 * coin flip on whether it landed inside one.
 */
export async function checkEventLightsInCombat({ page, check }, frames = 90) {
  const watch = await page.evaluate(async (n) => {
    // A target, parked, for the same reason the phaser block above does it: a
    // sweep that finds nothing is a check on luck. Nothing here asserts where
    // the hostile is, only that hitting one lights the sector.
    const p = window.__player;
    const f = window.__fleet;
    p.heading = 0;
    p.velocity.set(0, 0, 0);
    for (const h of f.hostiles) {
      h.position.set(p.position.x, 0, p.position.z + 18);
      h.velocity.set(0, 0, 0);
    }
    window.__eventLights.clear();

    // Sampled once per frame from inside the page rather than by polling from
    // node: a spike curve is most of the way over inside a few hundred
    // milliseconds, and an evaluate round-trip is long enough to step over one
    // entirely. Per-frame sampling cannot miss a flash that any frame drew.
    const seen = { peak: 0, lit: 0, frames: 0 };
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const slots = window.__eventLights.inspect();
      seen.frames++;
      seen.peak = Math.max(seen.peak, ...slots.map((s) => s.intensity));
      seen.lit = Math.max(seen.lit, slots.filter((s) => s.intensity > 0).length);
    }
    return { ...seen, hostiles: f.hostiles.length, slots: window.__eventLights.inspect().length };
  }, frames);
  check(
    "a firefight lights the pool without the harness asking it to",
    watch.peak > 0 && watch.lit > 0,
    JSON.stringify(watch),
  );
  check(
    "...and the pool is still eight slots afterwards",
    watch.slots === 8,
    `slots=${watch.slots}`,
  );
  await page.evaluate(() => window.__eventLights.clear());
}

// ── the post chain ──────────────────────────────────────────────────────────

/**
 * `Stage.ts`'s own measured decision: the scene is drawn into a multisampled
 * target and the chain *starts from that target's texture*, so exactly one
 * resolve happens a frame. Handing `EffectComposer` a multisampled target
 * instead makes it clone that target for its second ping-pong buffer, so all
 * five passes resolve and only the first has geometry in it — 4.91 ms against
 * 2.46 ms on an M2 Max at 2560x1440.
 *
 * That is invisible in every screenshot and in every other assertion here. The
 * only thing that can catch it is reading the two sets of buffers and checking
 * they disagree about `samples` in the right direction.
 *
 * `sceneTarget` and `composer` are `private` in TypeScript, which is a
 * compile-time claim and not a runtime one; a harness reading them is reading
 * the object the game is actually running, which is the whole job. Said out
 * loud so nobody "fixes" this by inventing an accessor that exists only here.
 */
export async function checkPostChain({ page, check }) {
  const chain = await page.evaluate(() => {
    const stage = window.__stage;
    const composer = stage.composer;
    const tone = stage.toneMap;
    return {
      sceneSamples: stage.sceneTarget.samples,
      maxSamples: stage.renderer.capabilities.maxSamples,
      pingSamples: composer.renderTarget1.samples,
      pongSamples: composer.renderTarget2.samples,
      passes: composer.passes.map((p) => p.constructor.name),
      indices: {
        texture: composer.passes.findIndex((p) => p.constructor.name === "TexturePass"),
        bloom: composer.passes.indexOf(stage.bloom),
        phosphor: composer.passes.indexOf(stage.phosphor),
        crt: composer.passes.indexOf(stage.crt),
        tone: composer.passes.indexOf(tone),
        render: composer.passes.findIndex((p) => p.constructor.name === "RenderPass"),
      },
      toneLast: composer.passes[composer.passes.length - 1] === tone,
      toneSwaps: tone.needsSwap === true,
      toneEnabled: tone.enabled !== false,
      rendererToneMapping: stage.renderer.toneMapping,
      exposure: tone.exposure,
      shoulder: tone.shoulder,
      desaturation: tone.desaturation,
    };
  });

  check(
    "the scene target is multisampled",
    chain.sceneSamples === Math.min(4, chain.maxSamples) && chain.sceneSamples > 0,
    `samples=${chain.sceneSamples} max=${chain.maxSamples}`,
  );
  // The half that costs 3.2x when it is wrong.
  check(
    "...and the composer's own ping-pong buffers are not",
    chain.pingSamples === 0 && chain.pongSamples === 0,
    `ping=${chain.pingSamples} pong=${chain.pongSamples}`,
  );
  // Order matters and is written down in CLAUDE.md: scene -> bloom -> phosphor
  // -> CRT -> output encode. Asserted as *relative* order rather than as a
  // literal pass list, deliberately: the chain has already grown a TAA resolve
  // and a god-ray pass since that line was written, and a test that spelled the
  // list out would have to be edited for every addition — which is a test that
  // gets edited to agree rather than one that catches anything. What may never
  // change is the sequence these five stand in.
  const ix = chain.indices;
  check(
    "the chain draws from the scene target's texture rather than re-rendering the scene",
    ix.texture >= 0 && ix.render === -1,
    `texture=${ix.texture} renderPass=${ix.render} | ${chain.passes.join(" -> ")}`,
  );
  check(
    "the passes still run source -> bloom -> phosphor -> CRT -> encode",
    ix.texture < ix.bloom && ix.bloom < ix.phosphor && ix.phosphor < ix.crt && ix.crt < ix.tone,
    chain.passes.join(" -> "),
  );
  check(
    "ToneMapPass is present, last, and swaps",
    chain.toneLast && chain.toneSwaps && chain.toneEnabled,
    `last=${chain.toneLast} swap=${chain.toneSwaps} enabled=${chain.toneEnabled}`,
  );
  // The operator is the pass's, and only the pass's. three applying its own on
  // top would tone-map twice, which looks like a washed-out frame and reads
  // like a bug in the pass.
  check(
    "...and three's own tone mapping stays off, so the operator is applied once",
    chain.rendererToneMapping === NO_TONE_MAPPING,
    `renderer.toneMapping=${chain.rendererToneMapping}`,
  );

  // Highlights no longer hard-clip. This restates three lines of the pass's own
  // GLSL in JS, which is worth saying plainly — it is not an end-to-end check
  // and a GLSL typo would not fail it. What it *does* pin is the live uniforms
  // against the property they exist to provide: a shoulder pushed to 1 (or an
  // exposure that puts the knee past it) restores hard clipping, and nothing
  // else in this suite would notice a flat white core.
  const roll = (peak) => {
    if (peak <= chain.shoulder) return peak;
    const d = 1 - chain.shoulder;
    return 1 - (d * d) / (peak + d - chain.shoulder);
  };
  const core = roll(5.6 * chain.exposure);
  const bright = roll(1.0 * chain.exposure);
  check(
    "the shoulder sits below white, so no finite input can clip",
    chain.shoulder > 0 && chain.shoulder < 1 && chain.exposure > 0,
    `shoulder=${chain.shoulder} exposure=${chain.exposure}`,
  );
  check(
    "...a 5.6x core and a 1.0x highlight land apart rather than both on white",
    core < 1 && bright < 1 && core - bright > 0.02,
    `1.0x -> ${bright.toFixed(4)}, 5.6x -> ${core.toFixed(4)}`,
  );
  check(
    "...and the rolloff is still monotonic, so brighter never reads dimmer",
    roll(2) > roll(1.5) && roll(50) > roll(20) && roll(50) < 1,
    `2->${roll(2).toFixed(4)} 50->${roll(50).toFixed(4)}`,
  );
}

// ── the nebula ──────────────────────────────────────────────────────────────

/**
 * What is assertable about a volume that never bakes here: its *plan*.
 *
 * `aim()` reports where the band, the embedded star and the disc are, in world
 * space, derived from the same seed-and-sector hash the bake reads. That is
 * pure CPU arithmetic and is identical on a GPU and on SwiftShader, so
 * determinism — the property that makes a sector the same place every time you
 * come back to it — is fully covered here despite the bake being refused.
 *
 * Walked with `__sky.pin`/`next`, which is what that probe exists for.
 */
export async function checkNebula({ page, check }) {
  const nebula = await page.evaluate(() => {
    const aim = window.__nebula.aim();
    const state = window.__nebula.state();
    const t = window.__nebula.targets;
    const len = (v) => Math.hypot(v[0], v[1], v[2]);
    const apart = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    return {
      aim,
      state,
      constants: !!window.__nebula.constants,
      preview: t.preview?.width ?? null,
      full: t.full?.width ?? null,
      unit: aim ? ["pole", "cloud", "star", "disc"].map((k) => len(aim[k])) : null,
      // The embedded star sits *inside* the cloud complex and the disc sits on
      // the band, so these are three related but distinct directions. All four
      // collapsing onto one another is what a plan built from one hash instead
      // of four looks like.
      spread: aim ? apart(aim.pole, aim.cloud) : null,
      starNearCloud: aim ? apart(aim.star, aim.cloud) : null,
    };
  });

  check(
    "the nebula has a plan even though the bake was refused",
    nebula.aim !== null && nebula.constants,
    JSON.stringify({ aim: nebula.aim !== null, constants: nebula.constants }),
  );
  check(
    "...whose directions are unit vectors, which is what every consumer assumes",
    nebula.unit !== null && nebula.unit.every((l) => Math.abs(l - 1) < 1e-6),
    JSON.stringify(nebula.unit),
  );
  // Four directions from four hash lanes. The cloud is well off the pole, and
  // the star is *in* the cloud rather than anywhere — which is the shape of the
  // plan, and would collapse if the lanes were ever collapsed into one.
  check(
    "...and the cloud, its star and the pole stand in the right relation",
    nebula.spread > 0.3 && nebula.starNearCloud < nebula.spread,
    `pole-to-cloud=${nebula.spread?.toFixed(3)} star-to-cloud=${nebula.starNearCloud?.toFixed(3)}`,
  );
  check(
    "the two cube targets exist at their documented sizes",
    nebula.preview === 192 && nebula.full === 1024,
    `preview=${nebula.preview} full=${nebula.full}`,
  );
  // A refused bake must not leave the sky claiming to be ready — that is what
  // would put an unwritten cube on screen.
  check(
    "...and a refused bake never reports itself ready",
    nebula.state.ready === 0 && nebula.state.fullReady === false && nebula.state.previewReady === false,
    JSON.stringify(nebula.state),
  );
}

/**
 * ### What this block deliberately does *not* assert, and why
 *
 * Determinism per seed+sector — "the same sector is the same nebula, and two
 * sectors are two nebulae" — was written, run, and taken out again. It is the
 * property most worth having here and it is not assertable from outside today:
 *
 *  - With `__scenery.hide()` in force (which this harness needs, for the reason
 *    `playtest.mjs` gives on its first page), forcing `__campaign.current` never
 *    changes `__nebula.aim()` at all — measured over a five-second poll per
 *    sector, four sectors, repeatedly.
 *  - With the scenery shown, it changes for *some* sectors and not others.
 *
 * Both readings are consistent with `nebula.show` being short-circuited while
 * the object is hidden, and with a sector change reaching `sky.show` but not
 * `nebula.show` — and nothing exposed can tell those apart, because the one
 * fact that would settle it is which key the nebula is currently standing on.
 * A test that cannot distinguish "the feature is broken" from "the probe cannot
 * see the feature" is a test that will be deleted the first time it goes red.
 *
 * **The probe that would close this** is `key` on `__nebula`'s own object —
 * `key: (): string => this.key` beside `state()` in `Nebula.ts` — plus
 * `plane: () => backdrop.plane` on `__sky` in `main.ts`. With those two the
 * assertion is three lines and unambiguous: force a sector, wait for the key to
 * become `${seed}:${sector}`, then compare plans.
 */

// ── the rock field ──────────────────────────────────────────────────────────

/**
 * Thousands of rocks are drawn instanced; only the boulders are collidable, and
 * `Asteroids.rocks` is still the plain world-space `{x, y, z, r}[]` that
 * `game/session.ts` and `game/hostiles.ts` iterate directly. Both halves of
 * that sentence are load-bearing and neither is visible: a `rocks` list that
 * quietly started carrying gravel would make the hazard field a wall, and a
 * `rocks` list that moved to instance-local coordinates would put every
 * collision in the wrong place while still looking exactly right.
 */
export async function checkRocks({ page, check }) {
  const field = await page.evaluate(async () => {
    const { planLight } = await import("/src/render/light.ts");
    const { ASTEROIDS } = await import("/src/render/Asteroids.ts");
    const asteroids = window.__asteroids;
    const seed = window.__campaign.seed;

    const snapshot = (sector) => {
      asteroids.show(seed, sector, true, planLight(seed, sector));
      return {
        rocks: asteroids.rocks.map((r) => ({ x: r.x, y: r.y, z: r.z, r: r.r })),
        instances: asteroids.instanceCount,
      };
    };

    // Two different sectors, then back to the first — determinism, and that the
    // two are actually different fields rather than one cached one.
    const a1 = snapshot(21);
    const b1 = snapshot(34);
    // `show` is key-cached, so returning needs the key broken first. A third
    // sector does that without asserting anything about it.
    snapshot(47);
    const a2 = snapshot(21);

    const shape = a1.rocks.every(
      (r) =>
        typeof r.x === "number" &&
        typeof r.y === "number" &&
        typeof r.z === "number" &&
        typeof r.r === "number" &&
        Number.isFinite(r.x + r.y + r.z + r.r) &&
        r.r > 0,
    );
    // World space, not instance-local: a boulder field is scattered across a
    // flattened ellipsoid centred well away from the origin, so a list that had
    // quietly become object-local would sit in a tiny cloud around zero.
    const spread = a1.rocks.reduce((m, r) => Math.max(m, Math.hypot(r.x, r.y, r.z)), 0);

    return {
      a1,
      b1,
      a2,
      shape,
      spread,
      boulders: ASTEROIDS.heroBoulderCount,
      band: { min: ASTEROIDS.heroRadiusMin, max: ASTEROIDS.heroRadiusMax },
      radiusMin: Math.min(...a1.rocks.map((r) => r.r)),
      radiusMax: Math.max(...a1.rocks.map((r) => r.r)),
    };
  });

  check(
    "the collidable list is a world-space {x,y,z,r} list",
    field.shape && field.spread > 20,
    `n=${field.a1.rocks.length} shape=${field.shape} spread=${field.spread.toFixed(1)}`,
  );
  // Boulders only. The instanced draw carries thousands; the hazard must not.
  check(
    "...of boulders only, not of everything the field draws",
    field.a1.rocks.length === field.boulders && field.a1.instances > field.boulders,
    `rocks=${field.a1.rocks.length} boulders=${field.boulders} instances=${field.a1.instances}`,
  );
  // The radius is the *collision* sphere, and it has to stay the boulder band
  // rather than the drawn one: `heroAxisMin`/`Max` jitter each rock's outline
  // per axis and the sphere deliberately does not follow, so a `rocks` list
  // that started reporting drawn extents would make every hitbox disagree with
  // every silhouette by a few percent — invisible, and wrong everywhere.
  check(
    "...carrying the boulder band's own nominal radius, not a drawn one",
    field.radiusMin >= field.band.min - 1e-6 && field.radiusMax <= field.band.max + 1e-6,
    `r=${field.radiusMin.toFixed(2)}..${field.radiusMax.toFixed(2)}, band ${field.band.min}..${field.band.max}`,
  );
  const identical =
    field.a1.rocks.length === field.a2.rocks.length &&
    field.a1.rocks.every((r, i) => {
      const s = field.a2.rocks[i];
      return r.x === s.x && r.y === s.y && r.z === s.z && r.r === s.r;
    });
  check(
    "a sector's rock field is the same field every time you return to it",
    identical,
    `n=${field.a1.rocks.length}/${field.a2.rocks.length}`,
  );
  const differs =
    field.b1.rocks.length !== field.a1.rocks.length ||
    field.b1.rocks.some((r, i) => {
      const s = field.a1.rocks[i];
      return !s || r.x !== s.x || r.z !== s.z || r.r !== s.r;
    });
  check(
    "...and two sectors are two different fields",
    differs,
    `a=${field.a1.rocks.length} b=${field.b1.rocks.length}`,
  );

  // The switch the harness itself depends on. Hiding a body must be a
  // `visible` flag and nothing more — a hide that disposed and a show that
  // rebuilt would recompile, which is the 170 ms class of stall `eventLights`
  // exists to avoid, arriving from the other direction.
  //
  // Measured **synchronously**, with no frame in between, and that is the point
  // rather than a shortcut: the alternative — show, render, hide, render — puts
  // the gas giant's hand-written domain-warped-noise shader in front of
  // SwiftShader's compiler, which is an LLVM JIT and the reason this harness
  // hides the scenery on the first line of the file. A cycle that allocates
  // nothing and compiles nothing cannot stall, and "allocates nothing" is
  // exactly what identical material and geometry instances across the cycle
  // says.
  const recompile = await page.evaluate(() => {
    // Collected from the whole scene rather than from the rock field's own
    // node, because a sector with no hero field and no furniture has nothing
    // under that node to compare — `Asteroids.show` builds children only for
    // the clusters a sector actually rolled, so a per-body snapshot is empty
    // roughly one sector in four and the check silently becomes vacuous.
    const collect = () => {
      const seen = [];
      window.__stage.scene.traverse((o) => {
        if (o.material) seen.push({ material: o.material, geometry: o.geometry });
      });
      return seen;
    };
    const programs = () => window.__stage.renderer.info.programs.length;

    const before = { programs: programs(), parts: collect() };
    window.__scenery.show();
    const shown = { programs: programs(), parts: collect(), visible: window.__asteroids.object.visible };
    window.__scenery.hide();
    const hidden = { programs: programs(), parts: collect(), visible: window.__asteroids.object.visible };

    const identical = (a, b) =>
      a.length === b.length && a.every((p, i) => p.material === b[i].material && p.geometry === b[i].geometry);

    return {
      programs: [before.programs, shown.programs, hidden.programs],
      parts: before.parts.length,
      sameOnShow: identical(before.parts, shown.parts),
      sameOnHide: identical(before.parts, hidden.parts),
      toggled: shown.visible === true && hidden.visible === false,
    };
  });
  check(
    "the scenery switch really does toggle the field",
    recompile.toggled && recompile.parts > 0,
    JSON.stringify(recompile),
  );
  check(
    "...by moving a flag, not by disposing and rebuilding a single material",
    recompile.sameOnShow && recompile.sameOnHide,
    JSON.stringify(recompile),
  );
  check(
    "...so a hide/show cycle allocates no program to compile",
    recompile.programs[0] === recompile.programs[1] && recompile.programs[1] === recompile.programs[2],
    JSON.stringify(recompile.programs),
  );

  // Put the field back where the sector says it should be. `Asteroids.show` is
  // key-cached and `main.ts` only calls it on a sector change, so leaving this
  // block's sector 21 standing would mean every later rock check ran against a
  // field the campaign never chose.
  await page.evaluate(async () => {
    const { planLight } = await import("/src/render/light.ts");
    const { planHero } = await import("/src/render/scenery.ts");
    const seed = window.__campaign.seed;
    const sector = window.__campaign.current;
    window.__asteroids.show(seed, sector, planHero(seed, sector) === "rocks", planLight(seed, sector));
  });
}

// ── the two lit bodies ──────────────────────────────────────────────────────

/**
 * The gas giant and the ringed planet are the only two things in the game that
 * shade themselves per fragment against the sector's own star, and the three
 * properties worth pinning are all uniforms rather than pixels: the terminator
 * is light-aware, the ring shadows the body and the body shadows the ring, and
 * the giant's rotation is *differential* — the poles turn slower than the
 * equator, so an initially-rigid pattern shears apart as the run goes on.
 *
 * Both bodies are forced to stand rather than waited for: `planHero` casts the
 * giant at 0.30 and the ringed planet at 0.20, so waiting for a sector that
 * rolls one would be a coin flip on the campaign seed.
 */
export async function checkLitBodies({ page, check }) {
  const bodies = await page.evaluate(async () => {
    const { planLight } = await import("/src/render/light.ts");
    const { planHero } = await import("/src/render/scenery.ts");
    const seed = window.__campaign.seed;

    // Any sector will do — these bodies take the sector's light as an argument
    // rather than rolling one, so the hero cast is irrelevant to what is being
    // asserted here.
    const sector = 5;
    const light = planLight(seed, sector);
    window.__giant.show(seed, sector, light);
    window.__planet.show(seed, sector);

    const u = (mesh) => (mesh ? mesh.material.uniforms : null);
    const g = u(window.__giant.body);
    const pb = u(window.__planet.body);
    const pr = u(window.__planet.ring);
    const pl = u(window.__planet.limb);

    const dir = light.position.clone().normalize();
    const agrees = (uniform) => {
      if (!uniform) return null;
      const v = uniform.value;
      return Math.abs(v.x - dir.x) + Math.abs(v.y - dir.y) + Math.abs(v.z - dir.z);
    };

    return {
      hero: planHero(seed, sector),
      giant: g
        ? {
            hasLightDir: !!g.uLightDirWorld,
            lightAgrees: agrees(g.uLightDirWorld),
            diffPole: g.uDiffPole?.value ?? null,
            rotation: g.uRotation.value,
            shearAmp: g.uShearAmp?.value ?? null,
            lit: !!g.uLightColor,
          }
        : null,
      planetBody: pb
        ? {
            hasLightDir: !!pb.uLightDirWorld,
            lightAgrees: agrees(pb.uLightDirWorld),
            ringInner: pb.uRingInnerR?.value ?? null,
            ringOuter: pb.uRingOuterR?.value ?? null,
            ringNormal: pb.uRingNormal ? pb.uRingNormal.value.length() : null,
            ringDepth: pb.uRingDepth?.value ?? null,
            diffPole: pb.uDiffPole?.value ?? null,
          }
        : null,
      planetRing: pr
        ? {
            bodyRadius: pr.uBodyRadius?.value ?? null,
            shadowSoft: pr.uShadowSoft?.value ?? null,
            hasLightDirLocal: !!pr.uLightDirLocal,
          }
        : null,
      hasLimb: pl !== null,
    };
  });

  check(
    "the giant is a lit mesh reading the sector's own star",
    bodies.giant !== null && bodies.giant.hasLightDir && bodies.giant.lit && bodies.giant.lightAgrees < 1e-6,
    JSON.stringify(bodies.giant),
  );
  check(
    "the ringed planet's body reads the same star",
    bodies.planetBody !== null && bodies.planetBody.hasLightDir && bodies.planetBody.lightAgrees < 1e-6,
    JSON.stringify(bodies.planetBody),
  );
  // The ring shadow on the body: the body's shader has to know where the ring
  // is, how thick it is, and which way its plane faces, or the band it casts
  // is not the band that is drawn.
  check(
    "the body carries the ring's shadow",
    bodies.planetBody !== null &&
      bodies.planetBody.ringInner > 0 &&
      bodies.planetBody.ringOuter > bodies.planetBody.ringInner &&
      Math.abs(bodies.planetBody.ringNormal - 1) < 1e-6 &&
      bodies.planetBody.ringDepth > 0,
    JSON.stringify(bodies.planetBody),
  );
  // ...and the other direction, which is the half a still frame makes easy to
  // forget: the planet's own shadow falling across its rings.
  check(
    "...and the ring carries the body's",
    bodies.planetRing !== null &&
      bodies.planetRing.bodyRadius > 0 &&
      bodies.planetRing.hasLightDirLocal,
    JSON.stringify(bodies.planetRing),
  );
  check(
    "the ringed planet stands up all three of its meshes",
    bodies.planetBody !== null && bodies.planetRing !== null && bodies.hasLimb === true,
    `body=${bodies.planetBody !== null} ring=${bodies.planetRing !== null} limb=${bodies.hasLimb}`,
  );

  // Differential rotation. `uRotation` is one advancing number and the shader
  // multiplies it by a latitude term running from `uDiffPole` at the poles to 1
  // at the equator — so the divergence between a pole and the equator is
  // `rotation * (1 - diffPole)` and grows without bound. Rigid rotation is
  // exactly `diffPole === 1`, and that is what this catches.
  //
  // `update` is called here rather than waited on, and that is not a shortcut:
  // `main.ts` only steps the giant in the sector that cast it as the hero, and
  // this block forced a body to stand in a sector that almost certainly did not
  // — so waiting on the clock would be waiting for a call that is correctly
  // never made. Driving `update` with a known `dt` also makes the divergence
  // below an exact figure instead of a race.
  const spin = await page.evaluate(() => {
    const read = () => window.__giant.body.material.uniforms.uRotation.value;
    const before = read();
    window.__giant.update(0.5);
    const mid = read();
    window.__giant.update(0.5);
    return { before, mid, after: read() };
  });
  check(
    "the giant's rotation advances on the clock, proportionally to it",
    spin.mid > spin.before && Math.abs(spin.after - spin.mid - (spin.mid - spin.before)) < 1e-9,
    `${spin.before} -> ${spin.mid} -> ${spin.after}`,
  );
  check(
    "...differentially, so the poles lag the equator further the longer you watch",
    bodies.giant !== null &&
      bodies.giant.diffPole !== null &&
      bodies.giant.diffPole < 1 &&
      bodies.giant.diffPole > 0 &&
      (spin.after - spin.before) * (1 - bodies.giant.diffPole) > 0,
    `diffPole=${bodies.giant?.diffPole}, pole lags equator by ${(
      (spin.after - spin.before) * (1 - (bodies.giant?.diffPole ?? 1))
    ).toFixed(5)} rad per simulated second`,
  );
  // The unbounded-on-purpose half: `update` wraps every other phase and
  // deliberately does not wrap this one, because wrapping would snap every
  // latitude's accumulated offset back into agreement and erase the shear.
  check(
    "...and the rotation is not wrapped, or the shear would reset every turn",
    spin.after > 0,
    `rotation=${spin.after}`,
  );

  // Both bodies back to the sector the campaign is actually standing in —
  // `show` is key-cached off `${seed}:${sector}` and `main.ts` only calls it on
  // a sector change, so a forced sector left standing here would be the one
  // every later check saw.
  await page.evaluate(async () => {
    const { planLight } = await import("/src/render/light.ts");
    const seed = window.__campaign.seed;
    const sector = window.__campaign.current;
    window.__giant.show(seed, sector, planLight(seed, sector));
    window.__planet.show(seed, sector);
    window.__scenery.hide();
  });
}

// ── forcing the real media path ─────────────────────────────────────────────

/**
 * Part 2 of the SwiftShader answer, and the part that actually closes most of
 * the hole: `__media.setQuality(1)` and rebuild a shoal, so the volume the
 * game constructs here is the one a player's machine constructs.
 *
 * **It never draws.** `__scenery.hide()` has already put `shoals.object.visible`
 * to false and the volume's mesh is a child of that node, so no fragment is
 * rasterised, no program is compiled, and the march costs exactly nothing. That
 * is what makes forcing the real path affordable on software GL — the expensive
 * half of a volumetric medium is per-fragment and the assertable half is not.
 *
 * The quality is put back before this returns, and the curtain rebuilt, so
 * everything downstream sees the stroke renderer it was written against.
 */
export async function checkForcedMediaPath({ page, check }) {
  const forced = await page.evaluate(async () => {
    const { planShoal, SHOAL_MEDIA } = await import("/src/render/Shoals.ts");
    // Read off the window handle, never imported — see this file's import rule.
    // A bare `import("/src/render/shaders/media.ts")` forks a second copy of
    // the module whose `setQuality` moves a cache nothing else reads, which is
    // precisely the failure this whole block would otherwise report as "the
    // renderer refuses to build a volume it plainly can".
    const MEDIA = window.__media.MEDIA;
    const { CURVES } = await import("/src/render/eventLights.ts");
    const { PALETTE } = await import("/src/render/palette.ts");
    const { planLight } = await import("/src/render/light.ts");
    const shoals = window.__shoals;
    const seed = window.__campaign.seed;

    let sector = -1;
    for (let s = 0; s < 64; s++) {
      if (planShoal(seed, s)) {
        sector = s;
        break;
      }
    }
    if (sector < 0) return { skip: true };

    // What the fallback builds, for the same sector, so the comparison is
    // between two renderings of one plan rather than two plans.
    window.__media.setQuality(0);
    shoals.show(seed, -1);
    shoals.show(seed, sector);
    const fallback = { medium: shoals.medium !== null, plan: shoals.plan !== null };

    // The real path.
    window.__media.setQuality(1);
    shoals.show(seed, -1);
    shoals.show(seed, sector);
    const medium = shoals.medium;
    if (!medium) {
      window.__media.setQuality(0);
      shoals.show(seed, -1);
      shoals.show(seed, sector);
      return { skip: false, fallback, built: false };
    }

    const plan = shoals.plan;
    const mesh = medium.mesh;
    const uniforms = medium.material.uniforms;
    const has = (name) => name in uniforms;

    // The proxy must be the oriented box the bounds test is written against —
    // `mediaBounds` works in world space and reads `uCentre`/`uAcross`/
    // `uDepth`/`uExtent`, so a proxy that disagreed with those uniforms would
    // rasterise fragments the march then discards, or worse, clip fragments the
    // march wanted.
    const centre = uniforms.uCentre.value;
    const extent = uniforms.uExtent.value;
    const proxyAgrees =
      Math.abs(mesh.position.x - centre.x) < 1e-6 &&
      Math.abs(mesh.position.z - centre.z) < 1e-6 &&
      Math.abs(mesh.scale.x - extent.x * 2) < 1e-4 &&
      Math.abs(mesh.scale.y - extent.y * 2) < 1e-4 &&
      Math.abs(mesh.scale.z - extent.z * 2) < 1e-4;

    // The centre must be where the plan put the curtain, in world space.
    const wantX = Math.sin(plan.bearing) * plan.range;
    const wantZ = Math.cos(plan.bearing) * plan.range;
    const centreAgrees = Math.abs(centre.x - wantX) < 1e-4 && Math.abs(centre.z - wantZ) < 1e-4;

    // Lit by the sector's own star, not by a second roll of one.
    const light = planLight(seed, sector);
    const toStar = light.position.clone().sub(centre).normalize();
    const keyDir = uniforms.uKeyDir.value;
    const keyAgrees =
      Math.abs(keyDir.x - toStar.x) + Math.abs(keyDir.y - toStar.y) + Math.abs(keyDir.z - toStar.z) < 1e-5;

    // Light injection: the pool holds eight, the shader is compiled for four,
    // and `injectLights` must hand over the best four by irradiance at the
    // volume's centre. Done in one tick so no `update` can decay a slot
    // mid-measurement.
    const lights = window.__eventLights;
    lights.clear();
    const at = (d) => centre.clone().add(new centre.constructor(d, 0, 0));
    // Eight equal lights at increasing distance: the nearest four must win.
    for (let i = 0; i < 8; i++) {
      lights.flash(at(20 * (i + 1)), PALETTE.trace.clone(), 5, 2, { curve: CURVES.steady, radius: 400 });
    }
    medium.injectLights(lights, centre);
    const count = uniforms.uLightCount.value;
    const chosen = uniforms.uLightPos.value.slice(0, count).map((p) => Math.abs(p.x - centre.x));
    chosen.sort((a, b) => a - b);

    lights.clear();
    medium.injectLights(lights, centre);
    const darkCount = uniforms.uLightCount.value;

    const result = {
      skip: false,
      sector,
      fallback,
      built: true,
      mediaLights: MEDIA.lights,
      uniforms: {
        centre: has("uCentre"),
        across: has("uAcross"),
        depth: has("uDepth"),
        extent: has("uExtent"),
        keyDir: has("uKeyDir"),
        lightCount: has("uLightCount"),
        lightPos: has("uLightPos"),
        sigma: has("uSigma"),
        anisotropy: has("uAnisotropy"),
      },
      // ES 1.00 needs a loop bound the compiler can fold, so the caller's step
      // count is *baked into the emitted GLSL* rather than passed as a uniform
      // — which means a `steps` that silently stopped reaching the march would
      // leave the shader marching the core's default instead of the shoal's
      // fourteen, at more than twice the cost, with nothing visibly wrong.
      wantSteps: SHOAL_MEDIA.steps,
      stepsBaked: medium.material.fragmentShader.includes(`i < ${SHOAL_MEDIA.steps}; i++`),
      proxyAgrees,
      centreAgrees,
      keyAgrees,
      visible: shoals.object.visible,
      parented: mesh.parent === shoals.object,
      frustumCulled: mesh.frustumCulled,
      renderOrder: mesh.renderOrder,
      side: medium.material.side,
      depthWrite: medium.material.depthWrite,
      transparent: medium.material.transparent,
      count,
      chosen,
      darkCount,
    };

    // Put the machine back the way the rest of the suite expects it.
    window.__media.setQuality(0);
    shoals.show(seed, -1);
    shoals.show(seed, window.__campaign.current);
    result.restored = { medium: shoals.medium !== null, quality: window.__media.quality() };
    return result;
  });

  if (forced.skip) {
    check("this seed grows a shoal somewhere to force the real path on", false, "no shoal in 64 sectors");
    return;
  }

  check(
    "on software GL the shoal really is the stroke curtain, not a volume",
    forced.fallback.plan === true && forced.fallback.medium === false,
    JSON.stringify(forced.fallback),
  );
  check(
    "forcing quality on builds the volume a player's machine would build",
    forced.built === true,
    JSON.stringify(forced),
  );
  if (!forced.built) return;

  check(
    "...compiled with the core's own uniform set",
    Object.values(forced.uniforms).every(Boolean),
    JSON.stringify(forced.uniforms),
  );
  check(
    "...and the caller's own step count folded into the march",
    forced.stepsBaked === true,
    `wanted "i < ${forced.wantSteps}; i++" in the emitted GLSL`,
  );
  check(
    "the proxy hull is the oriented box the bounds test is written against",
    forced.proxyAgrees,
    JSON.stringify(forced),
  );
  check(
    "...standing where the plan put the curtain, in world space",
    forced.centreAgrees,
    JSON.stringify(forced),
  );
  check(
    "...lit by the sector's own star rather than a second roll of one",
    forced.keyAgrees,
    JSON.stringify(forced),
  );
  // The compositing setup, which is the part that is silently wrong rather than
  // visibly wrong: front faces vanish the moment the camera enters the medium.
  check(
    "the volume composites from its back faces, unculled, before everything else",
    forced.side === 1 && forced.frustumCulled === false && forced.renderOrder === -5 && forced.depthWrite === false,
    `side=${forced.side} culled=${forced.frustumCulled} order=${forced.renderOrder} depthWrite=${forced.depthWrite}`,
  );
  // ...and it hangs off the node `__scenery` switches, which is both a real
  // property of the build and the reason this whole block is affordable here.
  check(
    "...and hangs off the node the scenery switch hides, so it never drew here",
    forced.parented === true && forced.visible === false,
    `parented=${forced.parented} visible=${forced.visible}`,
  );
  check(
    "eight event lights are ranked down to the four the march is compiled for",
    forced.count === forced.mediaLights && forced.chosen.length === forced.mediaLights,
    `count=${forced.count} of ${forced.mediaLights}`,
  );
  check(
    "...and the four kept are the four nearest, not the first four",
    forced.chosen.length === 4 &&
      forced.chosen.every((d, i) => d <= 20 * (i + 1) + 1e-6) &&
      forced.chosen[3] <= 80 + 1e-6,
    `distances=${JSON.stringify(forced.chosen)}`,
  );
  check(
    "an unlit sector injects nothing rather than stale positions",
    forced.darkCount === 0,
    `count=${forced.darkCount}`,
  );
  check(
    "dropping the quality back restores the stroke curtain the rest of this suite assumes",
    forced.restored.medium === false && forced.restored.quality === 0,
    JSON.stringify(forced.restored),
  );
}

// ── the frame cap ───────────────────────────────────────────────────────────

/**
 * `FRAME_CAP` in `main.ts` accepts a frame only once 75% of a 60 Hz interval
 * has elapsed, so a 120 Hz display renders 60 and a 60 Hz one renders 60. On
 * SwiftShader the harness is nowhere near either — the renderer is the
 * bottleneck, callbacks arrive slower than the threshold, and every one is
 * accepted. So simply counting frames here proves nothing about the cap.
 *
 * **The display is faked instead.** `requestAnimationFrame` is wrapped so the
 * timestamp it hands the frame loop advances at a quarter speed, which is
 * exactly what a display four times faster looks like from inside `frame`:
 * successive callbacks land ~4 ms apart on the clock the cap reads, well under
 * its 12.5 ms threshold, so the cap must start rejecting. No probe and no
 * browser flag needed, and `main.ts` re-reads `window.requestAnimationFrame`
 * every frame, so the wrapper can be installed and removed at will.
 *
 * What is measured is the interval between accepted frames on the faked clock,
 * which has to land between 1000/16.67 = 60 (the cap's nominal rate) and
 * 1000/12.5 = 80 (its tolerance edge, reached when a callback lands just past
 * the threshold every time). Anything outside that band means the cap is not
 * 60, or is not there.
 */
export async function checkFrameCap({ page, check }) {
  // How fast this host's callbacks actually arrive, measured rather than
  // assumed: headless Chromium here runs them at ~120 Hz and a loaded one at
  // under 20 Hz, and the compression below has to put the *scaled* period
  // comfortably under the cap's 12.5 ms threshold either way — otherwise the
  // cap has nothing to reject and the test measures the display instead.
  const period = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        let first = 0;
        const step = (t) => {
          if (n === 0) first = t;
          if (++n >= 20) resolve((t - first) / (n - 1));
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
  // Target ~1.5 ms of scaled callback period: eight or more callbacks per
  // accepted frame, so the cap is unambiguously the thing doing the rejecting
  // and the interval it holds is resolved to better than 1.5 ms.
  //
  // Faking *exactly* 120 Hz was tried first and does not work here, which is
  // worth recording rather than rediscovering: SwiftShader's own callback
  // period swings between 20 and 50 ms run to run, a fixed scale preserves that
  // jitter proportionally, and a jittery 120 Hz lands accepted frames anywhere
  // from 12.5 ms to 25 ms apart. So the display is faked *fast* and the claim is
  // checked against the cap's whole legal interval instead, which distinguishes
  // 60 from 120 (a 120 fps cap would hold 6.25 ms) and from no cap at all
  // (which would hold the raw callback period, ~1.5 ms).
  const scale = Math.max(0.005, Math.min(1, 1.5 / Math.max(period, 0.1)));

  await page.evaluate((s) => {
    const raf = window.requestAnimationFrame.bind(window);
    window.__capWatch = { raf: 0, accepted: 0, origin: null, first: null, last: null, scale: s };
    const w = window.__capWatch;
    // The timestamp is compressed, not the wall clock: everything else in the
    // page keeps real time, so nothing but the frame loop's own gate notices.
    //
    // **Anchored at the first timestamp seen, not at zero.** Scaling the raw
    // value would hand `frame` a `now` some tens of seconds *behind* the `last`
    // it is already holding, and the cap would then reject every callback until
    // the compressed clock caught back up — which reads exactly like a cap set
    // to one frame a minute. Compressing only the elapsed part keeps the clock
    // continuous across the swap, which is the whole trick.
    window.requestAnimationFrame = (cb) =>
      raf((t) => {
        w.raf++;
        if (w.origin === null) w.origin = t;
        const scaled = w.origin + (t - w.origin) * w.scale;
        if (w.first === null) w.first = scaled;
        w.last = scaled;
        cb(scaled);
      });
    const stage = window.__stage;
    const render = stage.render.bind(stage);
    w.restore = () => {
      window.requestAnimationFrame = raf;
      delete stage.render;
    };
    // `stage.render` is the last line of an accepted frame and is not reached
    // by a rejected one, which makes it the honest counter for "frames the cap
    // let through". `w.last` is the scaled timestamp of the callback currently
    // running, so recording it here dates each accepted frame on the clock the
    // cap itself is reading.
    w.stamps = [];
    stage.render = (dt) => {
      w.accepted++;
      w.stamps.push(w.last);
      render(dt);
    };
  }, scale);
  await page.waitForTimeout(3000);
  const cap = await page.evaluate(() => {
    const w = window.__capWatch;
    w.restore();
    const gaps = w.stamps.slice(1).map((t, i) => t - w.stamps[i]);
    gaps.sort((a, b) => a - b);
    const out = {
      raf: w.raf,
      accepted: w.accepted,
      scale: w.scale,
      gaps: gaps.length,
      median: gaps.length ? gaps[gaps.length >> 1] : 0,
    };
    delete window.__capWatch;
    return out;
  });

  // The *interval between accepted frames*, on the cap's own clock, rather
  // than a count over a span: with the display faked fast the span is short and
  // a rate computed from it is quantised by whole frames, while the interval is
  // resolved to one scaled callback period whatever the span was.
  const rate = cap.median > 0 ? 1000 / cap.median : 0;
  check(
    "the frame loop is running fast enough for the cap to have something to reject",
    cap.raf > cap.accepted * 1.5,
    `raf=${cap.raf} accepted=${cap.accepted}`,
  );
  // The band is derived, not picked. With callbacks 8.33 ms apart and a
  // threshold at 12.5 ms, the cap accepts on the second callback every time and
  // there is no other answer it can give: 16.67 ms, 60 frames a second. The
  // slack is for measurement, not for the mechanism.
  check(
    "FRAME_CAP still holds 60 when the display runs far faster",
    cap.gaps >= 3 && cap.median >= 12.0 && cap.median <= 17.5,
    `${rate.toFixed(1)} fps — median accepted interval ${cap.median.toFixed(2)}ms, wanted 12.5..16.67 ` +
      `(display faked to ${(1000 / (period * cap.scale)).toFixed(0)} Hz from a real ` +
      `${(1000 / period).toFixed(0)} Hz, raf=${cap.raf}, accepted=${cap.accepted})`,
  );
}

// ── the tuning console's page count ─────────────────────────────────────────

/**
 * The console's own history: an assertion here once hard-coded six `/` presses
 * to walk back to the first page, was correct for the seven pages that existed
 * when it was written, and broke silently the day an eighth was added. That was
 * fixed by cycling until arrival — but "nothing here knows how many pages there
 * are" is a property of the *file*, and the way to keep it is to assert the
 * page count against the registry rather than to remember not to write it down.
 *
 * So: one full lap of `/` must take exactly as many presses as the registry has
 * blocks, and every page on the way must be a different one.
 */
export async function checkTuningPages({ page, check }) {
  const blocks = await page.evaluate(() => window.__tuning.blocks.length);
  await page.keyboard.press("`");
  await page.evaluate(() => {
    window.__tuning.tuner.block = 0;
    window.__tuning.tuner.row = 0;
  });
  const seen = [await page.evaluate(() => window.__tuning.tuner.block)];
  for (let i = 0; i < blocks; i++) {
    await page.keyboard.press("/");
    seen.push(await page.evaluate(() => window.__tuning.tuner.block));
  }
  await page.keyboard.press("`");

  const lap = seen.slice(0, blocks);
  check(
    "one lap of the page key visits every block exactly once",
    blocks > 1 && new Set(lap).size === blocks,
    `blocks=${blocks} visited=${JSON.stringify(seen)}`,
  );
  check(
    "...and lands back on the first, so nothing here needs to know the count",
    seen[blocks] === 0,
    `after ${blocks} presses: block=${seen[blocks]}`,
  );
}
