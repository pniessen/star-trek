import {
  BasicShadowMap,
  type DirectionalLight,
  type InstancedMesh,
  type Mesh,
  type Object3D,
  PCFShadowMap,
  type Scene,
  Vector3,
  type WebGLRenderer,
} from "three";

/**
 * The sector's star, casting.
 *
 * Until this file, the scene's one real `DirectionalLight` produced a
 * *terminator* and nothing else: `render/VectorObject.ts`'s occluder fill and
 * `render/Asteroids.ts`'s rock instances both shade Lambert against it, so a
 * hull and a boulder each had a lit side and a dark side — but neither could
 * put anything *between* itself and the star. A field of ten thousand rocks
 * where every rock is lit and no rock is ever in another rock's shadow reads
 * as ten thousand independently glowing pebbles, which is the same complaint
 * `docs/environment.md` opened with one level up ("just look like wallpaper"):
 * lighting without occlusion is decoration, not a place.
 *
 * Everything here is deliberately *one* decision expressed in four small
 * entry points, because the two lines that have to live in files this work
 * does not own — `Stage.ts` (the renderer flag) and `main.ts` (the light) —
 * must each be a single call with no policy in them. Policy belongs in one
 * file so it can be argued with in one place.
 *
 * ## What was closed off
 *
 * **A world-fitted shadow camera was rejected.** The obvious shape is one
 * orthographic frustum covering everything the sector contains — but the
 * sector contains the far rock band out to 900 units and mid-field furniture
 * at 300–600, so "everything" is a ~1800-unit box. At 4096² that is 0.44
 * world units per texel, against boulders of radius 3 and gravel of radius
 * 0.3: the entire visual tier would be sub-texel and the boulders would cast
 * four-pixel smears. A directional shadow map is a *resolution* budget spent
 * on an *area*, and the area worth spending it on is the one the player is
 * standing in.
 *
 * **So the camera is fitted to combat space and follows the player.** Half-
 * extent `SHADOWS.extent`, recentred every frame on the focus point. That
 * costs one property write and a `lookAt`, and it buys ~0.08 world units per
 * texel — a boulder is 75 texels across and even a 0.3-unit gravel grain is
 * seven, which is the difference between a shadow and a stain. Engagement
 * ranges in this game run 14–78 units (`CLAUDE.md`'s own slab write-up cites
 * them), so an extent of 160 covers every fight the player is in with room
 * either side, and the rock field's own ±120 spread means flying into a
 * `"rocks"` sector puts the whole hazard tier inside the box.
 *
 * The price is a visible boundary: past `SHADOWS.extent` three's shadow
 * lookup falls outside the map and returns *lit*, so a distant rock's shadow
 * simply is not drawn rather than being drawn wrong. That is the right
 * failure — the alternative (clamping to the border texel) smears one edge
 * of the map across the whole far field. At 160 units against a fog far
 * plane of 260 the cutoff sits well into the haze.
 *
 * **The light moves its target, not itself.** `STAR.distance` is 20000, and
 * a `DirectionalLight`'s shadow camera is planted at the light's own world
 * position looking at its target — so recentring by moving the *light* would
 * mean carrying a 20000-unit offset around every frame and re-deriving the
 * near/far window from it. Moving only `light.target` recentres the frustum
 * for free, and the one side effect — the lighting direction swings by
 * `atan(300/20000)`, about 0.9 arcminutes — is beneath any threshold this
 * game has. `STAR.distance`'s own comment already argues the star is far
 * enough that no two bodies disagree about where it is; this is that same
 * property being spent.
 *
 * **The focus point is snapped to the shadow map's own texel grid.** Without
 * it, a continuously-moving ortho frustum resamples every shadow edge every
 * frame and the whole field crawls — the classic directional-shadow
 * shimmer, and much more visible here than in a textured game because the
 * receivers are flat-shaded facets with nothing to hide it. Snapping in the
 * light's own view plane makes the sampling grid world-stationary, so an
 * edge only moves when the geometry does.
 *
 * ## What does *not* get shadows, on purpose
 *
 * The hand-written `ShaderMaterial` bodies — the gas giant, the moon, the
 * sun, the nebula, the shoals — take no part. three.js only injects the
 * shadow chunks into materials it built, and every one of those files reads
 * `render/light.ts`'s `SectorLight` straight into its own uniforms precisely
 * *because* it wanted control three's pipeline would not give it. Forcing
 * shadows through them would mean hand-porting `shadowmap_pars_fragment`
 * into five shaders to shadow bodies that are hundreds to thousands of units
 * away and physically cannot be occluded by anything in combat space.
 *
 * Strokes take no part either, and never will, for the reason
 * `VectorObject`'s own header already gives: they are additive, so they *are*
 * the light rather than receiving it, and a stroke that darkened on one side
 * would read as a contact changing allegiance under the locked "colour is
 * information" rule.
 */

/**
 * Every number this file is. First-draft guesses of the same species as
 * `LOOM`, `COMET` and `ALTITUDE` — reasoned about, then flown once — and
 * candidates for the tuning console (`game/tuning.ts`) on the same terms
 * everything else in `docs/todo.md` §2 is.
 *
 * Mutable rather than `as const` because the console has to be able to move
 * these live; `applyShadowSettings` is the re-apply that makes a moved knob
 * take effect, since map size and frustum bounds are both cached by three
 * rather than read per frame.
 */
export interface ShadowSettings {
  mapSize: number;
  extent: number;
  depthPad: number;
  bias: number;
  normalBias: number;
  radius: number;
  snap: boolean;
  filter: "basic" | "pcf";
}

export const SHADOWS: ShadowSettings = {
  /**
   * Shadow map resolution, square.
   *
   * **Measured, M2 Max, 1512×982 at devicePixelRatio 2, camera parked inside
   * a `"rocks"` hero field of 9,813 instances**, interleaving on/off runs so
   * the machine's own drift cancels rather than being read as a result:
   * 2048 costs **+0.77 ms** a frame and 4096 **+1.01 ms**. A quarter of a
   * millisecond is what the whole doubling buys back, against a texel that
   * goes from 0.156 world units to 0.078 — which at `ASTEROIDS.gravelRadiusMin`
   * (0.3) is the difference between a grain casting four texels and casting
   * two. 4096 for that reason and no other.
   *
   * The real ceiling is memory rather than time: a 4096² depth texture is
   * 64 MB, nothing on desktop and the first thing that should drop on
   * anything integrated.
   *
   * Must be a power of two — there is no reason to find out what three does
   * otherwise.
   */
  mapSize: 4096,
  /**
   * Half-width of the orthographic shadow frustum, in world units, centred on
   * the focus point. This is the whole quality/coverage trade in one number:
   * texel size is `2 * extent / mapSize`, so 160 at 4096 gives 0.078 units
   * per texel.
   *
   * Chosen against three measurements the game already makes: engagement
   * ranges of 14–78, the altitude slab's ~14 units each way (so the vertical
   * axis is never the binding one), and the hero rock field's ±120 spread
   * about a centre 90–150 out. 160 keeps every fight and most of a rock field
   * inside the box; below ~100 the boundary starts cutting shadows off inside
   * the range you are actually shooting at.
   */
  extent: 160,
  /**
   * How far in front of and behind the focus plane the frustum reaches, in
   * world units, added to and subtracted from `STAR.distance`.
   *
   * Generous because it costs nothing: the shadow camera is orthographic, so
   * its depth buffer is *linear* — 600 units spread across 24 bits is 3.6e-5
   * units of resolution, which is four orders of magnitude finer than any
   * bias here. A perspective shadow camera at 20000 units would have no
   * usable precision at all, which is worth writing down as the reason this
   * is not a worry rather than leaving it looking like one.
   */
  depthPad: 300,
  /**
   * Constant depth offset, in the shadow map's own normalised depth. Negative
   * pushes the comparison toward the light, which is the direction that cures
   * acne.
   *
   * Deliberately tiny, and the reason is the geometry of this particular
   * shadow rather than timidity: with a linear ortho depth spread over
   * `2 * depthPad` world units this number is a *world* offset in disguise, so
   * -0.0001 is 0.06 units. It is a backstop for the surfaces `normalBias`
   * cannot help — the ones facing the star almost edge-on, where an offset
   * along the normal barely moves the sample point toward the light at all.
   */
  bias: -0.0001,
  /**
   * Offset along the surface normal before the shadow lookup, in world units —
   * the resolution-aware half of the bias pair, and the one worth flying.
   *
   * **It is not sized against depth precision, because there is none to
   * fight.** That is the surprise this file measured and is worth recording,
   * since it inverts the usual advice: an *orthographic* shadow camera has a
   * linear depth buffer, and this one spreads only `2 * depthPad` = 600 world
   * units across it, so quantisation is ~3.6e-5 units — four orders of
   * magnitude below any facet on any rock. Swept at 0, 0.03, 0.06, 0.12 and
   * 0.25 against an isolated-dark-pixel count (the signature of acne: a real
   * shadow edge is a run, a self-shadowing artefact is a speck), the reading
   * was 0.081%, 0.084%, 0.084%, 0.086%, 0.090% — flat, and *identical to the
   * same count with shadows switched off entirely* (0.089%). There is no acne
   * at zero bias in this scene.
   *
   * So what this actually guards is the **PCF kernel's lateral reach**, not
   * the depth buffer: three r185 samples five taps over a Vogel disk of
   * `SHADOWS.radius` texels, which at 1.6 × 0.078 is 0.125 world units away
   * from the shading point, and on a facet lying nearly edge-on to the star
   * those neighbours are genuinely behind it. 0.06 is half that reach — sized
   * to the thing it is for, and half rather than the whole because bias is not
   * free: sweeping it *up* shrinks the shadow monotonically (a hull's own cast
   * measured 0.22% of lit pixels at 0, 0.18% at 0.12, 0.13% at 0.5, 0.03% at
   * 6), which is peter-panning arriving before anything looks obviously wrong.
   *
   * Deliberately *not* derived from `extent`/`mapSize` automatically: a knob
   * that silently retunes itself when another knob moves cannot be flown
   * against, which is the whole premise of `game/tuning.ts`. Move `mapSize` or
   * `extent` a long way and this wants moving with them, by hand, on purpose.
   */
  normalBias: 0.06,
  /**
   * PCF kernel spread, in texels — the radius of the five-tap Vogel disk
   * three r185 samples the map with, rotated per fragment by an interleaved
   * gradient noise. Texel space rather than world space, so it softens a
   * distant shadow and a near one identically.
   *
   * Ignored entirely by `filter: "basic"`, which takes one tap.
   */
  radius: 1.6,
  /**
   * Whether the focus point is quantised to the shadow map's texel grid. On
   * by default and there is no good reason to turn it off except to see what
   * it was buying — which is exactly why it is a switch rather than a
   * hard-coded `true`. See the header's own paragraph on shimmer.
   */
  snap: true,
  /**
   * Filter kind, named rather than numeric so the console can page through it
   * as a choice.
   *
   * **`"pcf"` is the soft one, and `PCFSoftShadowMap` no longer exists.**
   * This is worth stating because every tutorial and most of this project's
   * own instincts say otherwise. In three r185 `PCFSoftShadowMap` is
   * deprecated — `WebGLShadowMap.render` warns and silently substitutes
   * `PCFShadowMap` — and the surviving `SHADOWMAP_TYPE_PCF` path was
   * rewritten into the good one: a hardware-compared `sampler2DShadow` read
   * five times over a Vogel disk of radius `SHADOWS.radius`, rotated per
   * fragment by an interleaved gradient noise so the sample pattern does not
   * band. `"basic"` is the leftover: one unfiltered tap and a hard `step`,
   * kept only as the A/B that shows what the filtering is buying.
   *
   * VSM is deliberately not offered. It needs its own blur passes and a
   * float map, and its characteristic failure — light leaking through a
   * thin occluder — would be worst on exactly the geometry this game is made
   * of, which is thin panelled hulls.
   */
  filter: "pcf",
};

const FILTERS = {
  basic: BasicShadowMap,
  pcf: PCFShadowMap,
} as const;

/**
 * The renderer half — the one line `render/Stage.ts` needs, in its
 * constructor, before anything has ever been drawn.
 *
 * **Timing is the whole reason this is a call rather than a note.** three
 * bakes `USE_SHADOWMAP` and the scene's shadow-casting light count into every
 * lit material's program, so flipping `shadowMap.enabled` after materials
 * exist relinks all of them — a sibling measured 170 ms in one frame for
 * three programs merely toggling a lit object's visibility. Called from the
 * constructor, no lit material exists yet, so the first frame compiles each
 * program exactly once *with* shadows and there is no second compile to pay
 * for. This is the same argument `main.ts`'s event-light pool already makes
 * for standing itself up at boot rather than on the first explosion.
 *
 * `autoUpdate` stays `true`. The tempting saving is to render the map only
 * when something moves — but in this game everything moves every frame: the
 * rock fields tumble (`ASTEROIDS.tumbleRate`), the hostiles fly, and the
 * frustum itself is chasing the player. A dirty flag that is set every frame
 * is a dirty flag with a bug in it.
 */
export function enableShadows(renderer: WebGLRenderer): void {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = FILTERS[SHADOWS.filter];
  renderer.shadowMap.autoUpdate = true;
}

/**
 * The light half — the one line `main.ts` needs, once, after `sun` is built
 * and added to the scene.
 *
 * Takes the scene and a focus accessor rather than being fed a point every
 * frame, so the caller keeps exactly one line. The per-frame recentre rides
 * `Scene.onBeforeRender`, which three calls from `WebGLRenderer.render`
 * immediately before it builds the render list and renders the shadow map
 * (three r185, `three.module.js` ~17644 against ~17702) — so a target moved
 * there is in place by the time `LightShadow.updateMatrices` reads it.
 *
 * Hooking the scene rather than asking `main.ts` for a second call in the
 * frame loop is the one liberty this file takes, and it is taken knowingly:
 * the alternative is a `focusShadow(sun, player.position)` line buried in a
 * 1800-line frame loop where its ordering against `stage.render` is a silent
 * correctness requirement. `focusShadow` is exported anyway (below) for a
 * caller who would rather have it explicit. Nothing else in `src/` sets
 * `scene.onBeforeRender` — `Nebula.ts` and `Shoals.ts` use the *object*-level
 * hook, which is a different callback — but this asserts rather than assumes,
 * because silently replacing someone else's callback is the kind of bug that
 * only shows up as "the nebula stopped working" three files away.
 */
export function installShadows(light: DirectionalLight, scene: Scene, focus: () => Vector3): void {
  if (scene.onBeforeRender !== Object.getPrototypeOf(scene).onBeforeRender) {
    throw new Error("installShadows: scene.onBeforeRender is already taken");
  }

  light.castShadow = true;
  applyShadowSettings(light);

  scene.onBeforeRender = (): void => {
    focusShadow(light, focus());
  };
}

/**
 * Push `SHADOWS` onto a light that is already casting. Separate from
 * `installShadows` because three caches both halves of what this writes —
 * the map is allocated at `mapSize` on first use and the frustum bounds are
 * only read through `projectionMatrix` — so a console knob that moved
 * `mapSize` or `extent` has to come back through here to take effect.
 *
 * Disposing the existing map is what makes a `mapSize` change actually
 * resize: three allocates `shadow.map` lazily and never checks it against
 * `mapSize` again.
 */
export function applyShadowSettings(light: DirectionalLight): void {
  const shadow = light.shadow;

  if (shadow.map !== null && shadow.mapSize.x !== SHADOWS.mapSize) {
    shadow.map.dispose();
    shadow.map = null;
  }
  shadow.mapSize.set(SHADOWS.mapSize, SHADOWS.mapSize);

  shadow.bias = SHADOWS.bias;
  shadow.normalBias = SHADOWS.normalBias;
  shadow.radius = SHADOWS.radius;

  const camera = shadow.camera;
  camera.left = -SHADOWS.extent;
  camera.right = SHADOWS.extent;
  camera.top = SHADOWS.extent;
  camera.bottom = -SHADOWS.extent;

  // Measured from the light's own world position, which is `STAR.distance`
  // out — see `SHADOWS.depthPad`. `LightShadow.updateMatrices` never calls
  // `updateProjectionMatrix` itself (it only recomposes the view matrix from
  // the light and its target), so this is the one place the bounds become
  // real.
  const distance = light.position.length();
  camera.near = Math.max(0.1, distance - SHADOWS.depthPad);
  camera.far = distance + SHADOWS.depthPad;
  camera.updateProjectionMatrix();
}

/** Scratch, module-level: this runs once a frame and three `Vector3`s a
 * frame handed to the collector for numbers thrown away immediately is the
 * same waste `render/light.ts`'s own `shadeAt` refuses. */
const AXIS_FORWARD = new Vector3();
const AXIS_RIGHT = new Vector3();
const AXIS_UP = new Vector3();
const WORLD_UP = new Vector3(0, 1, 0);
const SNAPPED = new Vector3();

/**
 * Recentre the shadow frustum on `point`. Exported so a caller who would
 * rather drive this explicitly from the frame loop can skip `installShadows`'
 * scene hook; `installShadows` calls it itself otherwise.
 *
 * The target — not the light — is what moves; see the header. The target is
 * not in the scene graph (a `DirectionalLight`'s default target never is), so
 * nothing else will ever update its world matrix and this has to do it by
 * hand. That is a feature rather than a chore: it means the write is
 * unconditional and cannot be silently undone by a later
 * `scene.updateMatrixWorld`.
 *
 * ## The snap
 *
 * `point` is quantised to the shadow map's texel grid *in the light's own
 * view plane* before it is used. The basis has to match the one
 * `Camera.lookAt` will build from the same two positions, or the quantisation
 * lands on a grid the sampler does not share and buys nothing: three's
 * `lookAt` gives `z = normalize(eye - target)`, `x = normalize(up × z)`,
 * `y = z × x`, so that is what is reconstructed here. `STAR.elevationDeg` is
 * 18, well off vertical, so `up × z` is never degenerate — a star overhead
 * would need a fallback and `render/light.ts` explicitly refuses to place
 * one there.
 *
 * The depth-axis component is deliberately *not* snapped. Quantising along
 * the view direction would move the near/far window rather than the sampling
 * grid, which is the one axis where movement is invisible (ortho depth is
 * linear and the pad is 300 units) and where snapping would cost a
 * needlessly coarse step.
 */
export function focusShadow(light: DirectionalLight, point: Vector3): void {
  const target = light.target;

  if (!SHADOWS.snap) {
    target.position.copy(point);
    target.updateMatrixWorld();
    return;
  }

  // `z` of the basis `lookAt` will build: from the target toward the light.
  // Using the light's position alone would be within a milliradian of this
  // (STAR.distance is 20000 against a focus that roams a few hundred) but
  // the subtraction is two adds, and a basis derived from the *actual* pair
  // cannot drift out of step with the one the camera ends up with.
  AXIS_FORWARD.copy(light.position).sub(point).normalize();
  AXIS_RIGHT.copy(WORLD_UP).cross(AXIS_FORWARD).normalize();
  AXIS_UP.copy(AXIS_FORWARD).cross(AXIS_RIGHT);

  const texel = (2 * SHADOWS.extent) / SHADOWS.mapSize;
  const u = Math.round(point.dot(AXIS_RIGHT) / texel) * texel;
  const v = Math.round(point.dot(AXIS_UP) / texel) * texel;
  const w = point.dot(AXIS_FORWARD);

  SNAPPED.set(0, 0, 0)
    .addScaledVector(AXIS_RIGHT, u)
    .addScaledVector(AXIS_UP, v)
    .addScaledVector(AXIS_FORWARD, w);

  target.position.copy(SNAPPED);
  target.updateMatrixWorld();
}

/**
 * Mark a mesh as taking part.
 *
 * `receive` defaults true and should stay true for every lit mesh in the
 * game, whether or not anything is ever likely to fall across it. That is not
 * laziness: `receiveShadow` is part of three's *program* cache key, so two
 * meshes sharing one material but disagreeing about it are two shader
 * programs — and the second one compiles at whatever unlucky moment it first
 * appears on screen. `render/Asteroids.ts` shares a single `ROCK_MATERIAL`
 * across every field in the game, which makes this a live hazard there rather
 * than a theoretical one. Uniform receive, selective cast: `castShadow` only
 * selects a shared depth material and creates no variant.
 */
export function shadowed(mesh: Mesh | InstancedMesh | Object3D, cast: boolean, receive = true): void {
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
}

/**
 * The handle, exposed unconditionally rather than behind `main.ts`'s own
 * `DEBUG_PROBE` — the same ruling `__scenery` and `__tuning` already carry,
 * for the same two reasons. The playtest harness is a consumer and does not
 * run on `localhost`, so a gated handle would break the one thing it is for;
 * and `docs/todo.md` §6.1's complaint is that a *tool* gated as a *probe* is
 * a tool nobody can use on the build they are playing.
 *
 * It matters more here than for most of this game's globals, because every
 * number in `SHADOWS` is a first-draft guess and shadows are the one feature
 * where the A/B is the entire review: `__shadows.SHADOWS.normalBias = 0.3;
 * __shadows.applyShadowSettings(sun)` is a two-line experiment, and
 * `renderer.shadowMap.enabled = false` is the before picture. No key is
 * spent on it, for the reason `__loom`/`__comet`/`__sky` already give: the
 * control surface is full.
 *
 * Guarded on `window` existing because `tools/audiotest.mjs` and
 * `tools/campaigntest.mjs` run modules in bare node — this file is not in
 * either's import graph today, and a module-level `window` reference is
 * exactly how that stops being true silently.
 */
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__shadows = {
    SHADOWS,
    enableShadows,
    installShadows,
    applyShadowSettings,
    focusShadow,
    shadowed,
  };
}
