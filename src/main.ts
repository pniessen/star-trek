import { AmbientLight, DirectionalLight, MathUtils, Vector3 } from "three";
import { Stage } from "./render/Stage.js";
import { VectorObject, type ShapeMode } from "./render/VectorObject.js";
import { TraceBuffer } from "./render/TraceBuffer.js";
import { Backdrop, backdrop } from "./render/Backdrop.js";
import { Planet } from "./render/Planet.js";
import { planLight, shadeAt, type SectorLight } from "./render/light.js";
import { GasGiant } from "./render/GasGiant.js";
import { PALETTE } from "./render/palette.js";
import {
  buildBastion,
  buildCruiser,
  buildHarrow,
  buildLance,
  buildRaider,
  buildShroud,
  buildSpinner,
  buildStarbase,
  buildWarden,
  buildPlayerHull,
} from "./geometry/hulls.js";
import { createGrid, createStarfield } from "./scene/environment.js";
import { DEFAULT_ERA, ERAS, eraSpec } from "./chart/eras.js";
import { Ship } from "./game/Ship.js";
import { ALTITUDE, flight } from "./game/altitude.js";
import { drawBeacons } from "./game/beacons.js";
import { Fleet, HOSTILE_COLORS, type HostileKind } from "./game/hostiles.js";
import { Wing } from "./game/allies.js";
import { LOOM, Loom, encounters } from "./game/loom.js";
import { COMET, Comet, interferenceAt, planFixture } from "./game/comet.js";
import { Session } from "./game/session.js";
import { Presentation } from "./game/presentation.js";
import { sound } from "./audio/sound.js";
import type { DeathSequence } from "./game/death.js";
import { drawHud } from "./hud/draw.js";
import { load, save } from "./chart/persistence.js";
import { colOf, indexOf, inBounds, neighbours, rowOf } from "./chart/sectors.js";
import { DECISIONS, decide } from "./chart/command.js";
import { jumpCharge, jumpSteps } from "./chart/jump.js";
import type { Campaign } from "./chart/campaign.js";

/** Publishes state on `window.__probe` for headless checks. */
const DEBUG_PROBE = location.hostname === "127.0.0.1" || location.hostname === "localhost";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const fault = document.getElementById("fault") as HTMLDivElement;

function fail(error: unknown): never {
  fault.style.display = "grid";
  fault.textContent = `RENDERER FAULT\n\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  throw error;
}

let stage: Stage;
try {
  stage = new Stage(canvas);
} catch (error) {
  fail(error);
}

// ── world ──────────────────────────────────────────────────────────────────

const grid = createGrid();
const trace = new TraceBuffer();
// A scenery scratch pad — `skyTrace`, `TraceBuffer(20000, false)`, `fog:
// false` for the reason `TraceBuffer`'s own header gives, kept separate
// from combat's `trace` so a busy firefight could never silently delete the
// sky — lived here until the giant, its only producer, moved to a lit mesh
// per `docs/environment.md` §1.5. Deleted along with it: an unused buffer
// needing a no-op `begin`/`end` pair just to stop it drawing 20000
// degenerate lines was a cost paid for nothing rather than for gas shoals
// or dust, which do not exist yet. `TraceBuffer`'s `(capacity, fog)`
// constructor parameters stay — they are what a later stage's own scratch
// pad will pass — this is only the premature instance.
const starfield = createStarfield();
// The sky of whichever sector the run is in. Added once and then only ever
// rebuilt in place; it draws between the starfield and the grid and is pinned
// to the camera's position every frame. See `render/Backdrop.ts`.
const sky = new Backdrop();
/**
 * The sector's ringed planet, and the one piece of scenery that is *not* on the
 * backdrop. It lives in world space so its parallax and its ring's aspect are
 * real rather than animated — see `render/Planet.ts` for why the previous two
 * attempts at this read as fake.
 */
const planet = new Planet();
stage.scene.add(
  grid.object,
  starfield.object,
  trace.object,
  sky.object,
  planet.object,
);

/**
 * How stretched the sky is, 0-1, eased rather than snapped.
 *
 * It leads the charge — the sky is already smearing before the jump fires —
 * and decays after arrival, so a jump reads as being flung somewhere and
 * coasting to a stop rather than as a cut between two frames.
 */
let warpStretch = 0;

const HULLS = {
  cruiser: buildCruiser(),
  swarmer: buildRaider(),
  sniper: buildLance(),
  brawler: buildBastion(),
  miner: buildHarrow(),
  stalker: buildShroud(),
  warden: buildWarden(),
  spinner: buildSpinner(),
};

const player = new Ship();
// Built at the baseline and corrected once the campaign has loaded, because the
// campaign is read below this line and the hull has to exist before `Session` is
// constructed with it. See the `swapPlayerHull()` call after that.
let playerHull = new VectorObject(buildPlayerHull(DEFAULT_ERA), {
  color: PALETTE.trace,
  linewidth: 1.8,
}).addTo(stage.scene);
// Aircraft order: yaw about the world's up, then pitch about the ship's own
// right, then roll about its own nose. The default XYZ was harmless while the
// only non-zero angles were yaw and a transient bank, but it applies pitch
// about the *world* X axis, so a climbing ship heading east would have rolled
// instead of pitched. Bank is unchanged by this — it was already rolling about
// the hull's own forward and still is.
playerHull.group.rotation.order = "YXZ";

const fleet = new Fleet((kind: HostileKind) =>
  new VectorObject(HULLS[kind], {
    color: HOSTILE_COLORS[kind],
    linewidth: 1.4,
  }).addTo(stage.scene),
);

// The ally. Drawn a little finer than the player's hull and a little heavier
// than a hostile's: the stroke weight is the third thing, after outline and
// colour, that says which of the two cyan ships on screen is the one you fly.
const wing = new Wing(() =>
  new VectorObject(HULLS.warden, {
    color: PALETTE.trace,
    linewidth: 1.6,
  }).addTo(stage.scene),
);

// The Loom's two spinners. Drawn at a hostile's weight, because that is what
// they are to a player deciding where the next shot goes — but in the violet
// that means "sown, not shot", which is what tells you they are not aiming back.
const loom = new Loom(() =>
  new VectorObject(HULLS.spinner, {
    color: PALETTE.harrow,
    linewidth: 1.4,
  }).addTo(stage.scene),
);

/**
 * The comet. Unlike `Loom`, it takes no shape factory — `Comet` builds and
 * disposes its own rock inside `show()` rather than pooling one, because a
 * sector ever has at most one comet standing rather than two spinners to
 * reuse. `object` holds only the nucleus; the tail is strokes pushed straight
 * into the shared `TraceBuffer`, drawn beside the Loom's weave below.
 */
const comet = new Comet();
stage.scene.add(comet.object);

/**
 * The hero gas giant — `docs/environment.md` §3's stage-1 prototype, rebuilt
 * per §1.5 as a lit mesh rather than strokes. One instance, fixed dead ahead
 * of spawn rather than seeded like `Planet`'s bearing — `render/GasGiant.ts`'s
 * own header explains why a body built to be looked at cannot risk rolling
 * behind the player. `object` holds the whole thing now, body and limb shell
 * together — there is no scratch-pad `TraceBuffer` for it to push strokes
 * into any more.
 */
const giant = new GasGiant();
stage.scene.add(giant.object);

const STARBASE_POSITION = new Vector3(0, 0, 118);
const starbase = new VectorObject(buildStarbase(), {
  color: PALETTE.traceDim,
  linewidth: 1.5,
}).addTo(stage.scene);
starbase.group.position.copy(STARBASE_POSITION);

// ── campaign ───────────────────────────────────────────────────────────────

// Loaded once at boot rather than on demand, so holding Tab the first time
// never stalls on a synchronous read. `load` never throws — a corrupt or
// absent save quietly becomes a fresh campaign. Loaded before the session
// because the session reads it every frame — wave escalation and salvage
// both come from the sector you are currently in.
const campaign = load(window.localStorage, Date.now());

/**
 * The sector's star, cached the same way `sky`/`planet` cache their own plan
 * — a key comparison rather than a fresh `planLight` call every frame, since
 * a sector's light does not move once placed and `planLight` allocates a
 * `Vector3` and a `Color` each time it runs.
 */
let sectorLightKey = "";
let sectorLight: SectorLight = planLight(campaign.seed, campaign.current);
sectorLightKey = `${campaign.seed}:${campaign.current}`;

/**
 * The sector's star, as a real light — `docs/environment.md` §1.5: the whole
 * reason the stroke build carried a `shadeAt` per-stroke multiply was that
 * `VectorObject` bakes vertex colours and cannot express a moving lit side.
 * `planLight`'s seeded position/colour are what aims it. Owned here rather
 * than by `GasGiant` because a light is a property of the *sector*, not of
 * one body in it (§3.1) — a second lit body later reads this same light
 * rather than carrying its own.
 *
 * **`GasGiant.body` no longer consumes this pair through three.js's own
 * lighting pipeline.** It did, briefly, through a `MeshStandardMaterial` —
 * that build read as a planet but could not express a crisp band edge, so
 * `render/GasGiant.ts`'s second rebuild moved banding into a hand-written
 * `ShaderMaterial`, and a hand-written shader is never fed scene lights
 * automatically. `giant.show` below is handed `sectorLight` directly instead,
 * the same object this pair is built from, so the two never disagree — but
 * that means `sun`/`sunFill` currently light nothing at all. They stay,
 * unremoved: the comment two paragraphs up is still the design, not just the
 * history — the *sector's* light is meant to be one physical thing a second
 * lit body can pick up for free, and deleting the standing light because its
 * one current consumer stopped using it would delete the part of the
 * architecture that consumer never should have needed to know about.
 *
 * `MeshBasicMaterial`-family and additive materials — every hull, the HUD,
 * `Backdrop`'s painted bodies, `Planet`'s ring — ignore both lights below by
 * construction (`three.js` never samples scene lights for an unlit
 * material), so this pair currently touches nothing in the scene at all.
 */
const sun = new DirectionalLight(0xffffff, 1.4);
sun.position.copy(sectorLight.position);
sun.color.copy(sectorLight.colour);
/**
 * A low, constant floor under the star, so a real material's night side does
 * not go to literal zero — the same purpose `STAR.floor` served for
 * `shadeAt`'s Lambertian term (`render/light.ts`'s own comment: "a hole where
 * geometry should be"), now spent as a second light instead of a floor added
 * inside a shading function no longer being called. Low enough that the
 * terminator this whole task exists to produce still reads clearly.
 */
const sunFill = new AmbientLight(0xffffff, 0.12);
stage.scene.add(sun, sunFill);

/**
 * The one place the browser's storage is named. Everything below hands this to
 * whoever needs to persist, so the campaign rules stay free of the DOM and a
 * test can substitute a plain object.
 */
const persist = (state: Campaign): void => save(state, window.localStorage);

const session = new Session(fleet, wing, loom, comet, STARBASE_POSITION, playerHull, campaign);

const presentation = new Presentation(
  session,
  player,
  fleet,
  STARBASE_POSITION,
  campaign,
  persist,
);

/** Eased 0→1 while `Tab` is held. The overlay fades; the run behind it does not pause. */
let chartOpacity = 0;
/** The sector the chart cursor is pointing at, independent of `campaign.current`. */
let chartCursor = campaign.current;
/** Detects the mode changes that run `session.restart()` inside `Presentation.enter()` — see `adoptMode`. */
let previousPresentationMode = presentation.mode;
/**
 * Takes the cursor to the sector the new mode actually starts in.
 *
 * Every mode change — title → attract, attract → title, an abandoned tally
 * back to title, `startRun()` — calls `session.restart()` inside
 * `Presentation.enter()`, which resets `campaign.current` to `campaign.front`.
 * `chartCursor` is a module-level `let` with no equivalent reset, so without
 * this it would still point at wherever a previous run's or the demo's own
 * jump last aimed it, carrying that stale front into whatever comes next.
 *
 * The frame loop calls this when it notices the mode changed underneath it,
 * which is a frame late. That is fine for a mode change nothing is waiting on
 * and wrong for one the player is mid-keypress of, so the two places that
 * change mode *and then act on the same press* — `R`, and the tally handoff
 * into the command view — call it themselves, in order, before they act.
 */
function adoptMode(): void {
  chartCursor = campaign.current;
  previousPresentationMode = presentation.mode;
}

/** Which of the four decisions is highlighted in the command view. */
let commandSelection = 0;
/** The command view's answer to the last decision, refusal included. */
let commandMessage = "";

// ── controls ───────────────────────────────────────────────────────────────

const CAMERA_MODES = ["cockpit", "chase", "orbit"] as const;
type CameraMode = (typeof CAMERA_MODES)[number];

/**
 * Honour a saved era, once everything `swapPlayerHull` touches actually exists.
 *
 * This used to sit immediately after `Session` was constructed, which looked like
 * the right place — the hull has to exist before the session is handed one, so
 * correcting it just after seemed natural. It threw. `swapPlayerHull` reads
 * `settings`, declared below this line, and a `const` in its temporal dead zone
 * is a `ReferenceError` rather than an `undefined`: module evaluation stopped, the
 * screen stayed black, and no renderer fault was shown because the throw happened
 * before anything was in place to catch it.
 *
 * It only fired for a save carrying a non-default era, which is why nothing
 * caught it — every automated run starts from empty storage and takes the other
 * branch. `tools/playtest.mjs` now seeds one into storage and reloads for exactly
 * that reason.
 */
function adoptSavedEra(): void {
  if ((campaign.era ?? DEFAULT_ERA) !== DEFAULT_ERA) swapPlayerHull();
}

const settings = {
  shape: "occluded" as ShapeMode,
  camera: "chase" as CameraMode,
  bloom: true,
  phosphor: true,
  crt: true,
  diagnostics: true,
};

const held = new Set<string>();

/**
 * Keys pressed since the last frame, cleared once the frame has read them.
 *
 * `held` alone drops a tap that begins and ends between two frames — at 60fps
 * that is a 16ms window a fast player will find, and the shot simply never
 * happens. Latching the press means every tap fires exactly once, while holding
 * the key still auto-fires at the weapon's cooldown.
 */
const pressed = new Set<string>();

/**
 * Keys that adjust the display rather than play the game. Everything else
 * launches a run from the title or interrupts the demonstration, which is the
 * cabinet convention — but you should still be able to turn the CRT glass off
 * while admiring the title screen.
 */
const DISPLAY_KEYS = new Set(["g", "b", "f", "v", "h", "l", "m", "n", "y", "1", "2", "3", "[", "]", "-", "=", "tab"]);

/**
 * The command view's keys that only move a highlight — the two idioms of
 * `handleCommandKey` with nothing that commits. Everything here is free and
 * reversible, which is what makes it safe to honour on the very press that
 * opens the view.
 */
const NAVIGATION_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown"]);

/**
 * The command view's keyboard, in two idioms and no more.
 *
 * **WASD moves the sector cursor on the grid, on every screen that has a
 * grid.** It used to move the decision list here while the arrows moved the
 * map — the exact opposite of the in-run overlay, which is the same 8x8 map
 * with WASD on its cursor. So the one key group that meant "move around the
 * map" in flight meant "move around a list" thirty seconds later, on a screen
 * showing that same map, and a player arrived at this screen with a habit it
 * immediately contradicted. That is now the rule and it has no exceptions.
 *
 * The decision list therefore takes the up and down arrows: they are the other
 * pair, they are unused for the list, and in flight they fly the ship, so
 * nothing collides. Left and right are deliberately inert here — a second job
 * for them is how the ambiguity would come back.
 *
 * Two idioms is what keeps the "no submenus" rule honest: there is no third
 * mode to be in and nothing to descend into, so every decision is one keypress
 * from every other.
 */
function handleCommandKey(key: string): void {
  if (key === "enter" || key === "r") {
    presentation.startRun();
    commandMessage = "";
    return;
  }

  if (key === "w" || key === "a" || key === "s" || key === "d") {
    const nextCol = colOf(chartCursor) + (key === "d" ? 1 : key === "a" ? -1 : 0);
    // Row 0 is the enemy's home edge and is drawn at the top — see `drawGrid` —
    // so up the screen is a decreasing row, the same way the in-run cursor
    // reads it.
    const nextRow = rowOf(chartCursor) + (key === "s" ? 1 : key === "w" ? -1 : 0);
    if (inBounds(nextCol, nextRow)) chartCursor = indexOf(nextCol, nextRow);
    // The old answer was about the old sector, so it stops being true here.
    commandMessage = "";
    return;
  }

  if (key === "arrowup" || key === "arrowdown") {
    const step = key === "arrowup" ? -1 : 1;
    commandSelection = (commandSelection + step + DECISIONS.length) % DECISIONS.length;
    return;
  }

  if (key === " ") {
    commandMessage = decide(campaign, DECISIONS[commandSelection], chartCursor);
    // Saved on every decision rather than on the way out: a cabinet that is
    // closed mid-chart should have kept whatever was already bought.
    persist(campaign);
  }
}

/**
 * Rebuild the player's hull for the campaign's era.
 *
 * The geometry is baked at construction — `VectorObject` builds its edge list
 * from the merged mesh — so changing ship means a new object rather than a new
 * attribute. Disposed and replaced rather than kept around: four hulls held in
 * memory to save an allocation on a keypress nobody makes twice a minute is the
 * wrong trade, and `Session` holds the reference it was given, so it is told.
 */
function swapPlayerHull(): void {
  const previous = playerHull;
  playerHull = new VectorObject(buildPlayerHull(campaign.era ?? DEFAULT_ERA), {
    color: PALETTE.trace,
    linewidth: 1.8,
  });
  playerHull.setMode(settings.shape);
  playerHull.group.rotation.order = "YXZ";
  stage.scene.remove(previous.group);
  stage.scene.add(playerHull.group);
  session.setPlayerHull(playerHull);
  previous.dispose();
}

// Everything `adoptSavedEra` needs exists by here: the campaign, the session, the
// hull and `settings`. See its own comment for why the obvious earlier placement
// was a black screen.
adoptSavedEra();

/** Applied to every VectorObject in the scene, including ones spawned later. */
function applyShapeMode(): void {
  playerHull.setMode(settings.shape);
  starbase.setMode(settings.shape);
  planet.setMode(settings.shape);
  // The giant has no wireframe mode — `docs/environment.md` §1.5 rules that
  // "occluded geometry, not pure wireframe" governs hulls, not celestial
  // bodies, and the hand-written `ShaderMaterial` `GasGiant.ts` shades it
  // with (its second rebuild, after `MeshStandardMaterial` proved unable to
  // hold a crisp band edge) has nothing for `G` to toggle either.
  for (const hostile of fleet.hostiles) hostile.shape.setMode(settings.shape);
  for (const spinner of loom.spinners) spinner.shape.setMode(settings.shape);
  wing.escort?.shape.setMode(settings.shape);
  comet.setMode(settings.shape);
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  // Tab's default is to move focus off the canvas, which would silently
  // strip every other key binding out from under the player.
  if (key === " " || key === "tab" || key.startsWith("arrow")) event.preventDefault();
  if (event.repeat) return;
  held.add(key);
  pressed.add(key);

  // A browser will not run an AudioContext until the page has been touched, and
  // this is the touch: the same keypress that launches a run off the title. It
  // is a resume on every key after the first, and silent if there is no device.
  sound.start();

  switch (key) {
    case "g":
      settings.shape = settings.shape === "occluded" ? "wireframe" : "occluded";
      applyShapeMode();
      break;
    case "b":
      settings.bloom = !settings.bloom;
      stage.bloom.enabled = settings.bloom;
      break;
    case "f":
      settings.phosphor = !settings.phosphor;
      stage.phosphor.enabled = settings.phosphor;
      break;
    case "v":
      settings.crt = !settings.crt;
      stage.crt.enabled = settings.crt;
      break;
    case "h":
      settings.diagnostics = !settings.diagnostics;
      break;
    case "l":
      // The deck log, on and off. In `DISPLAY_KEYS` above so that pressing it
      // on the title screen turns the log off rather than launching a run into
      // one — the same courtesy the CRT glass and the slab already get.
      presentation.briefing.enabled = !presentation.briefing.enabled;
      // Turning it off while one is up means it now: a switch that only takes
      // effect next run would answer a player who is reading a log right this
      // second with nothing at all. Turning it back on does not conjure one —
      // the run this log was briefing is already under way.
      if (!presentation.briefing.enabled) presentation.briefing.skip();
      break;
    case "m":
      sound.muted = !sound.muted;
      break;
    case "y":
      // The slab, on and off. In `DISPLAY_KEYS` above so that pressing it on
      // the title screen changes the game rather than launching a run — the
      // same courtesy the CRT glass gets, and a good deal more necessary, since
      // this is the one setting that decides which of two games you are about
      // to play. Nobody has flown either, which is why it is a switch.
      flight.threeD = !flight.threeD;
      break;
    case "n": {
      /**
       * Cycle the hull. In `DISPLAY_KEYS` so pressing it on the title changes
       * the ship instead of launching a run — the trick `Y` and `L` already use.
       *
       * **Refused during a run**, which is the one guard this needs: an era is a
       * set of stat multipliers as well as an outline, and swapping shields and
       * reserve out from under a fight would be a cheat rather than a choice. It
       * is picked between wars, which is also when it means something.
       *
       * Persisted, because it rides on the campaign — `kobayashi.campaign` is
       * already the only thing this game writes to storage, so this needed no
       * second decision about what persists.
       */
      if (presentation.mode === "run") break;
      const order = ERAS.map((spec) => spec.id);
      const at = order.indexOf(campaign.era ?? DEFAULT_ERA);
      campaign.era = order[(at + 1) % order.length];
      persist(campaign);
      swapPlayerHull();
      break;
    }
    case "r":
      // Not while the log is up. `R` means "run again, now", and during the
      // opening log there is no run yet to repeat — so it falls through to the
      // skip below and means the same thing every other key does there.
      if (presentation.mode === "run" && !presentation.briefing.active) {
        // Through the shell, not straight into the session: `startRun()` is
        // what clears the resolved-run report. Calling `session.restart()`
        // directly left it set, so the *next* death would come up on the
        // command view showing the previous run's enemy report and without
        // ever having advanced the campaign for its own.
        presentation.startRun();
        // Without this a jump made last run leaves the cursor pointing at
        // wherever it was last aimed, not at the sector the new run actually
        // starts in. `run` → `run` is not a mode change, so the frame loop
        // would never notice on its own.
        adoptMode();
        // Straight out, rather than falling through to the skip below. Now
        // that every run opens on a log, `startRun` has just begun one — and
        // the press that asked for the run would otherwise destroy the
        // briefing it came with, on the frame it arrived. The one press that
        // is allowed to mean both is not this one.
        return;
      }
      break;
    case "1":
    case "2":
    case "3":
      settings.camera = CAMERA_MODES[Number(key) - 1];
      break;
    case "[":
      stage.phosphor.decay = Math.max(0, stage.phosphor.decay - 0.04);
      break;
    case "]":
      stage.phosphor.decay = Math.min(0.96, stage.phosphor.decay + 0.04);
      break;
    case "-":
      stage.bloom.strength = Math.max(0, stage.bloom.strength - 0.1);
      break;
    case "=":
      stage.bloom.strength = Math.min(3, stage.bloom.strength + 0.1);
      break;
  }

  if (DISPLAY_KEYS.has(key)) return;

  // The opening log ends on the frame the key arrives, whatever the key and
  // wherever the crawl has got to. This is a cabinet: the fastest way to make
  // the loop feel like homework is a crawl a player cannot get out of. Handled
  // before the mode dispatch because the log runs *inside* mode "run", and the
  // dispatch below would otherwise read a key aimed at the log as a key aimed
  // at a run that has not started.
  if (presentation.briefing.active) {
    presentation.briefing.skip();
    return;
  }

  if (presentation.mode === "command") {
    handleCommandKey(key);
  } else if (presentation.mode === "run") {
    // At the epitaph, any key that is not R brings the chart up early rather
    // than waiting out the dwell. R keeps meaning what it has always meant —
    // run again, now — so a player who only wants to fly never sees the chart
    // they did not ask for. Both paths go through the same campaign advance;
    // see `Presentation.resolveRun`.
    if (session.death.phase === "tally" && key !== "r") {
      presentation.enterCommand();
      // The advance has happened, so the board and `campaign.current` below
      // are this run's aftermath and not last run's. Adopting the mode here
      // rather than leaving it to the frame loop is what lets the key act on
      // the same press: a frame later the reset would land on top of whatever
      // the key just did and put the cursor back.
      adoptMode();
      // Opening the chart and reading the key are not alternatives. The press
      // that raises the view is a real press with a real meaning, and eating
      // it meant a player who died, saw the epitaph and reached for `D` got
      // "a screen appeared" instead of "the cursor moved" — then had to press
      // it again. Only the keys that just move a cursor come through: `Space`
      // spends salvage and `Enter` ends the visit, and neither should fire off
      // a press aimed at a screen the player had not seen yet.
      if (NAVIGATION_KEYS.has(key)) handleCommandKey(key);
    }
  } else {
    // Any key takes the controls off the title screen or out of the demo.
    presentation.startRun();
  }
});
window.addEventListener("keyup", (event) => held.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => held.clear());
window.addEventListener("resize", () => stage.setSize(window.innerWidth, window.innerHeight));
// A click is a gesture too, and somebody will click the canvas before pressing
// anything. The drone stops with the frame loop when the tab is hidden — rAF
// stops there, so without this the last level set would hold forever.
window.addEventListener("pointerdown", () => sound.start());
document.addEventListener("visibilitychange", () => sound.setPaused(document.hidden));

applyShapeMode();

// ── camera ─────────────────────────────────────────────────────────────────

const forward = new Vector3();
const eye = new Vector3();
const focus = new Vector3();

function placeCamera(mode: CameraMode, time: number): void {
  player.forward(forward);
  const camera = stage.camera;

  // Every offset below is now measured from the ship rather than from the
  // floor, so the camera rides the slab with it. Tracked exactly rather than
  // lagged: a lag would be a second easing constant nobody has tuned, and the
  // grid receding underneath is already the whole read on "I am climbing".
  const deck = player.position.y;

  if (mode === "cockpit") {
    // Sat exactly on the deck everything collapses onto a razor horizon; a
    // little height and a fractional look-down spreads the field enough to
    // read.
    eye.copy(player.position).addScaledVector(forward, 1.1).setY(deck + 1.7);
    focus.copy(eye).addScaledVector(forward, 24).setY(deck + 0.2);
  } else if (mode === "chase") {
    eye.copy(player.position).addScaledVector(forward, -12).setY(deck + 4.6);
    focus.copy(player.position).addScaledVector(forward, 8).setY(deck + 0.4);
  } else {
    const angle = time * 0.28;
    eye.set(
      player.position.x + Math.sin(angle) * 15,
      deck + 4.2 + Math.sin(time * 0.4) * 1.2,
      player.position.z + Math.cos(angle) * 15,
    );
    focus.copy(player.position);
  }

  // Shake on impact, scaled to how hard. Decays with `player.impact`.
  if (player.impact > 0.01) {
    const shake = player.impact * player.impact * 1.4;
    eye.x += (Math.random() - 0.5) * shake;
    eye.y += (Math.random() - 0.5) * shake;
    eye.z += (Math.random() - 0.5) * shake;
  }

  camera.position.copy(eye);
  camera.up.set(0, 1, 0);
  camera.lookAt(focus);
  camera.rotateZ(player.bank * (mode === "cockpit" ? 0.7 : 0.45));
}

/**
 * The title view: a slow orbit around a ship at rest, with the starbase
 * drifting through frame behind it. Nothing is flying this — it is the cabinet
 * showing you what it has.
 */
function placeTitleCamera(time: number): void {
  const camera = stage.camera;
  const angle = time * 0.16;

  // Pulled in from 21 units to 12. Test play said the ship and its figures "get
  // lost on the page", and the ship was the half of that a layout change could
  // not fix: at 21 units a hull is a thumbnail whatever the type around it does.
  // This is the screen where you choose what you are flying, so the thing you are
  // choosing should be the largest object on it.
  eye.set(
    player.position.x + Math.sin(angle) * 9.4,
    2.8 + Math.sin(time * 0.23) * 0.9,
    player.position.z + Math.cos(angle) * 9.4,
  );
  focus.copy(player.position).setY(0.35);

  camera.position.copy(eye);
  camera.up.set(0, 1, 0);
  camera.lookAt(focus);
  camera.rotateZ(Math.sin(time * 0.19) * 0.05);
}

/**
 * The command view is composed over empty sky, not over the ship.
 *
 * The title screen can sit around a hull because the panel leaves the middle of
 * the frame to it. This one cannot: it is a map and twelve rows of type filling
 * the screen, and a wireframe ship crossing the option list reads as clutter
 * rather than as the game continuing. So the camera pitches up off the plane
 * and holds a slow drift — the starfield has no edges to compete with the type.
 */
function placeCommandCamera(time: number): void {
  const camera = stage.camera;
  const angle = time * 0.045;

  eye.set(Math.sin(angle) * 60, 3, Math.cos(angle) * 60);
  // 60 units ahead and 42 up is roughly 35 degrees of pitch, which puts the
  // grid's far edge below the frame at the 62-degree field this stage uses.
  focus.set(eye.x + Math.sin(angle) * 60, 45, eye.z + Math.cos(angle) * 60);

  camera.position.copy(eye);
  camera.up.set(0, 1, 0);
  camera.lookAt(focus);
  camera.rotateZ(Math.sin(time * 0.11) * 0.02);
}

/**
 * Death takes the camera off the ship it was following.
 *
 * It holds low and close through the breakup — near enough that the shards go
 * past it — then rises and pulls back into a slow orbit, so the last thing a
 * run shows you is your own wreck getting smaller. The tilt comes on as it
 * withdraws: a horizon off true is what says nobody is flying this any more.
 */
function placeWreckCamera(death: DeathSequence, time: number): void {
  const camera = stage.camera;
  const t = death.withdraw;
  const angle = death.viewAngle + t * 1.1 + time * 0.03;

  // Off the wreck's own height, not off the floor: a ship lost at the ceiling
  // has to be looked at where it was lost, or the camera opens fourteen units
  // underneath the debris it is supposed to be watching.
  eye.set(
    death.wreck.x + Math.sin(angle) * MathUtils.lerp(12, 52, t),
    death.wreck.y + MathUtils.lerp(1.8, 24, t),
    death.wreck.z + Math.cos(angle) * MathUtils.lerp(12, 52, t),
  );
  focus.copy(death.wreck).setY(death.wreck.y + MathUtils.lerp(0.6, 0, t));

  if (death.shock > 0.01) {
    const shake = death.shock * death.shock * 3.2;
    eye.x += (Math.random() - 0.5) * shake;
    eye.y += (Math.random() - 0.5) * shake;
    eye.z += (Math.random() - 0.5) * shake;
  }

  camera.position.copy(eye);
  camera.up.set(0, 1, 0);
  camera.lookAt(focus);
  camera.rotateZ(MathUtils.lerp(0, 0.14, t));
}

// ── loop ───────────────────────────────────────────────────────────────────

/** Fade rate for the chart overlay, in nats/second — see `approach` below. */
const CHART_FADE_RATE = 7;

/**
 * Where WASD hands off between flying the ship and moving the chart cursor,
 * in terms of `chartOpacity`. Past this point the overlay reads as "up" to a
 * player even mid-fade, so the controls should already agree with what their
 * eyes are telling them rather than waiting for the fade to finish.
 */
const CHART_INPUT_THRESHOLD = 0.5;

/**
 * Exponential approach toward `target`, framerate-independent by construction
 * rather than merely close for small `dt`. The chart's fade is the one place
 * this file eases anything, so it earns its own tiny helper instead of
 * borrowing a lerp that would drift at a slow frame.
 */
function approach(current: number, target: number, dt: number, rate: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

let last = performance.now();
let time = 0;
let smoothedFps = 60;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;
  smoothedFps += (1 / Math.max(dt, 1e-4) - smoothedFps) * 0.08;

  // Hit-stop dilates *game* time for a few frames when something lands. The
  // `dt` above is untouched real seconds and so is its clamp: the dilation is a
  // separate, named, bounded multiplier, so a stalled frame and a landed
  // torpedo can never be mistaken for one another. See `game/hitStop.ts`.
  const gameDt = dt * session.timeScale;

  presentation.update(dt);

  // Where the ear is. Set before the session is stepped, so everything that
  // fires this frame is placed against this frame's heading.
  sound.listen(player.position.x, player.position.z, player.heading);
  let burn = 0;

  // A mode change nobody was mid-keypress of: notice it and take the cursor
  // with it. The keypress-driven ones have already called this themselves.
  if (presentation.mode !== previousPresentationMode) adoptMode();

  // The chart is an overlay on top of the run, not a pause of it — it fades on
  // its own clock using real `dt` so the ease reads the same on any machine.
  // Only over a run: the command view is already a chart, and raising a second
  // one over it would put two cursors on one screen.
  // The opening log, held in a local: it gates the session step, the camera,
  // the hull and the alert bed, and reading it four times from a value that
  // `presentation.update` may have just cleared is how those four disagree.
  const briefing = presentation.briefing.active;

  // Not over the log. The chart is an instrument of a run in progress, and
  // during the log there is no run in progress to overlay it on.
  const wantsChart = held.has("tab") && presentation.mode === "run" && !briefing;
  chartOpacity = approach(chartOpacity, wantsChart ? 1 : 0, dt, CHART_FADE_RATE);
  // Past the midpoint of the fade WASD is reading the map, not flying the
  // ship. Below it, control hands straight back — there is no separate mode
  // to get stuck in, just where this one number happens to be.
  const chartActive = chartOpacity > CHART_INPUT_THRESHOLD;
  if (chartActive) {
    const col = colOf(chartCursor);
    const row = rowOf(chartCursor);
    let nextCol = col;
    let nextRow = row;
    // One sector per press, not per frame: `pressed` only latches the first
    // keydown of a hold, so parking a finger on `D` does not sweep the cursor
    // across the whole grid in one held breath.
    // Both schemes drive the cursor. The arrows used to be exempt so that an
    // arrows-flyer could keep manoeuvring with the chart up — but that split the
    // controls by which hand you happened to have learned, and a WASD-flyer got
    // the manoeuvring while an arrows-flyer got it taken away. Accepting both is
    // the version nobody has to be told.
    //
    // It costs the ship's helm for as long as the chart is up, and that is a
    // *sharpening* of the locked decision rather than a breach of it. "The chart
    // does not pause the game" is still true: waves keep arriving, ordnance keeps
    // flying, the hull keeps taking it. What is gone is your ability to steer
    // through any of that — so raising the chart in a firefight now costs more
    // than it did, which is exactly what that decision says the chart is for.
    if (pressed.has("w") || pressed.has("arrowup")) nextRow -= 1;
    else if (pressed.has("s") || pressed.has("arrowdown")) nextRow += 1;
    else if (pressed.has("a") || pressed.has("arrowleft")) nextCol -= 1;
    else if (pressed.has("d") || pressed.has("arrowright")) nextCol += 1;
    if (inBounds(nextCol, nextRow)) chartCursor = indexOf(nextCol, nextRow);
  }

  // Both screens that are not a run: the title and the command view. The
  // session is not stepped at all in either, so no wave spawns behind a panel
  // nobody can shoot back from. The hull just turns on the spot so it presents
  // itself, which is the whole of what these screens ask of the sim.
  const betweenRuns = presentation.mode === "title" || presentation.mode === "command";

  if (briefing) {
    // Nothing at all. The run has begun and the board is empty — `restart()`
    // cleared it — so holding the session here is what makes the log a moment
    // before the drop rather than something to read while a wave closes. The
    // hull is not even turned on the spot: it is not the subject of this
    // screen, and it is hidden below.
  } else if (betweenRuns) {
    player.heading += dt * 0.2;
  } else {
    const alive = session.state !== "dead";
    // In attract mode the demo pilot has the stick; the keyboard is only
    // watched for the keypress that takes it away again.
    const demo = presentation.mode === "attract" ? presentation.fly(dt) : null;

    // Both schemes fly the ship, and both stop flying it while the chart is up,
    // where they step the cursor instead — see above. The arrows used to be
    // exempt; they are not any more, because an exemption that only helps the
    // hand you happened to learn is not a feature.
    const turn = demo
      ? demo.turn
      : (!chartActive && (held.has("arrowright") || held.has("d")) ? 1 : 0) -
        (!chartActive && (held.has("arrowleft") || held.has("a")) ? 1 : 0);
    const thrust = demo
      ? demo.thrust
      : (!chartActive && (held.has("arrowup") || held.has("w")) ? 1 : 0) -
        (!chartActive && (held.has("arrowdown") || held.has("s")) ? 1 : 0);
    // The engine bed reads the same thrust the flight model does, so reading
    // the map does not make the ship sound like it is still burning.
    burn = Math.max(0, thrust);

    // Altitude, on two keys now. `Q` and `E` flank `W`, which is the whole
    // argument for the pair: a WASD flyer reaches both without moving a hand,
    // and up-left / down-right is a mapping nobody has to be told. `Q` was
    // already chosen for sitting above `A`, and `E` is the mirror of it.
    //
    // The second binding was spent to buy the verb "under" — see the header of
    // `game/altitude.ts` for what a floor cost and what had to be preserved to
    // replace it. Holding both cancels, which `Ship.updateAltitude` handles
    // rather than this: the flight model should decide what conflicting input
    // means, not the reader of the keyboard.
    //
    // Deliberately *not* remapped while the chart is up, exactly as the arrows
    // are not: these are flight controls, and pulling the chart up over a
    // minefield is precisely when you want to still be able to move. The demo
    // pilot never asks for either — see `Presentation.fly`.
    const climb = demo ? false : held.has("q");
    const dive = demo ? false : held.has("e");

    // Hyperwarp: holding Shift commits to a jump at the chart cursor, wherever
    // it was last pointed. Releasing early is a refund of nothing — Session
    // owns every guard (dead, docked, already charging, already there), so
    // this is just the raw request, asked again every frame.
    if (!demo) {
      if (held.has("shift")) session.beginHyperwarp(chartCursor);
      else session.cancelHyperwarp();
    }

    // The station takes the helm during capture, and holds you in place while
    // moored — you can still turn and shoot, which is what stops a wave arriving
    // mid-dock from being a helpless mauling.
    const dock = session.docking;
    if (alive && !dock.controlsLocked) {
      const departing = dock.clearing ? Math.min(thrust, 0) : thrust;
      player.update(
        { turn, thrust: dock.held ? 0 : departing, climb, dive, held: dock.held },
        gameDt,
      );
    }

    session.update(dt, player, {
      firePhaser: alive && (demo ? demo.firePhaser : held.has(" ") || pressed.has(" ")),
      fireTorpedo: alive && (demo ? demo.fireTorpedo : held.has("x") || pressed.has("x")),
      thrust: alive && thrust > 0,
      // Tapped, never held: `pressed` only latches the first keydown, so a
      // panicking player leaning on C converts one warhead per press rather
      // than emptying the magazine into the reactor by accident.
      scram: alive && !demo && pressed.has("c"),
      // Tapped, not held. The brace is one commitment per press — a held key
      // would either re-strip every frame or need a cooldown to stop it, and
      // both are machinery around a decision that only has to be made once.
      brace: alive && !demo && pressed.has("z"),
    });
  }
  pressed.clear();

  // The two continuous voices: the alert drone rides the threat on the tube,
  // the engine rides the throttle. Levels, not events — the same contract the
  // gauges work under.
  sound.update({
    threat: session.threat,
    hull: player.hull,
    thrust: burn,
    speed: player.speed,
    // The log is not a run yet, so the alert bed stays off under it — the
    // panel blips the crawl fires are the only thing that should be audible.
    alive: !briefing && presentation.mode !== "title" && session.state !== "dead",
    docked: session.docking.held,
  });

  // Newly spawned hostiles have to inherit the current geometry mode, and so
  // does a Warden that arrived after the last time `G` was pressed — and so
  // does a comet's rock, rebuilt fresh every time `show()` plans a new one.
  for (const hostile of fleet.hostiles) hostile.shape.setMode(settings.shape);
  for (const spinner of loom.spinners) spinner.shape.setMode(settings.shape);
  wing.escort?.shape.setMode(settings.shape);
  comet.setMode(settings.shape);

  playerHull.group.position.copy(player.position);
  // Pitch first about the ship's own right, then roll about its own nose —
  // which is what the "YXZ" order set on the group at boot buys. Negative,
  // because a positive rotation about X carries +Z (forward) toward -Y, and a
  // climbing ship should have its nose up.
  playerHull.group.rotation.set(-player.pitch, player.heading, player.bank * 0.6);
  // On the title screen the hull is the subject whatever the camera mode says;
  // once it has become debris there is nothing left to draw.
  // The title screen is the hull's showcase; the command view is the chart's,
  // and a ship drifting across twelve rows of type is only in the way.
  // The opening log is the command view's problem all over again: a document
  // filling the frame, and a wireframe hull drifting across it is clutter over
  // the only thing on screen worth reading.
  playerHull.group.visible =
    !briefing &&
    (presentation.mode === "title" ||
      (presentation.mode !== "command" &&
        settings.camera !== "cockpit" &&
        !session.death.hidesHull));
  const stationSpin = time * 0.06;
  starbase.group.rotation.y = stationSpin;

  // The sector's star, recomputed only on the two frames a sector actually
  // changes on — see the cache's own declaration by `campaign`.
  const currentLightKey = `${campaign.seed}:${campaign.current}`;
  if (currentLightKey !== sectorLightKey) {
    sectorLightKey = currentLightKey;
    sectorLight = planLight(campaign.seed, campaign.current);
    sun.position.copy(sectorLight.position);
    sun.color.copy(sectorLight.colour);
  }
  // `show`/`follow` read `player.position` alone, not the camera, so unlike
  // `sky.follow(stage.camera)` below they do not have to wait for
  // `placeCamera` to run first — see `render/GasGiant.ts`'s own header.
  giant.show(campaign.seed, campaign.current, sectorLight);
  giant.follow(player.position);
  giant.update(dt);

  trace.begin();
  session.ordnance.draw(trace);
  session.mines.draw(trace, player);
  // The weave is a transient stroke like every other one here — a hundred and
  // twenty-six filaments as objects would be a hundred and twenty-six materials
  // for something that is, in the end, a line.
  session.loom.draw(trace);
  // The comet's tail, on the same terms: regenerated in full every call,
  // never accumulated. `object` (the rock) is a scene child and draws itself;
  // this is only the strokes.
  session.comet.draw(trace);
  session.debris.draw(trace);
  session.death.draw(trace);
  session.docking.draw(trace, player);
  // The station's approach lights. Given the hull's own rotation so they turn
  // with the ring they sit on, and raised while the player is actually close
  // enough to dock — which is what makes them a guide rather than a garnish.
  drawBeacons(
    trace,
    STARBASE_POSITION,
    time,
    stationSpin,
    MathUtils.clamp(1 - player.position.distanceTo(STARBASE_POSITION) / 90, 0, 1),
  );
  trace.end();

  grid.follow(player.position.x, player.position.z);

  // The log borrows the command view's camera, and for the same reason it was
  // written: pitched off the plane at open sky, where a starfield has no edges
  // to compete with type. Reused rather than reinvented — a fifth camera that
  // did the same job would be a fifth camera to keep in agreement.
  if (briefing || presentation.mode === "command") placeCommandCamera(time);
  else if (presentation.mode === "title") placeTitleCamera(time);
  else if (session.death.phase !== "none") placeWreckCamera(session.death, time);
  else placeCamera(settings.camera, time);

  // The sector's sky. `show` is a key comparison on all but the two frames a
  // war can change sector on — a run beginning and a jump arriving — and
  // `follow` has to come after the camera has been placed or the sky trails it
  // by a frame. It reads the player's own campaign even while the demonstration
  // is flying the throwaway one, exactly as the HUD's chart already does:
  // nothing here writes, so the locked "attract mode never touches the player's
  // campaign" rule is untouched, and the cabinet showing the sky of the sector
  // you would actually launch into is the better of the two readings anyway.
  sky.show(campaign.seed, campaign.current);
  // World-space, so it is told the sector and then left alone apart from the
  // leash that stops the player flying into it.
  planet.show(campaign.seed, campaign.current);
  planet.follow(player.position);
  // The jump's own charge drives the tear, so the sky winds up with the drive
  // and stops the instant it lets go — no second clock to keep in step.
  sky.warp(session.hyperwarp.phase === "charging" ? session.hyperwarp.progress : 0);
  sky.update(dt);
  sky.follow(stage.camera);

  drawHud(stage.hud, {
    player,
    session,
    fleet,
    presentation,
    starbase: STARBASE_POSITION,
    fps: smoothedFps,
    time,
    dt,
    cameraMode: settings.camera,
    camera: stage.camera,
    shapeMode: settings.shape,
    bloom: settings.bloom,
    phosphor: settings.phosphor,
    crt: settings.crt,
    muted: sound.muted,
    showDiagnostics: settings.diagnostics,
    campaign,
    chartOpacity,
    chartCursor,
    commandSelection,
    commandMessage,
  });

  if (DEBUG_PROBE) {
    const skyReport = sky.describe();
    (window as unknown as Record<string, unknown>).__probe = {
      state: session.state,
      // The shell around the run — "title" / "attract" / "run". `state` still
      // means what it always did; a title screen is not a phase of combat.
      mode: presentation.mode,
      // The opening log, which is a hold inside mode "run" rather than a mode
      // of its own — so a harness cannot see it from `mode` and has to be told.
      briefing: presentation.briefing.active,
      // What of it a player could read *this instant*. `briefing` alone says
      // the log is running, which is exactly what an empty screen with the
      // whole crawl still below the band also says — the bug this field exists
      // to make assertable. See `Briefing.readable`.
      briefingLines: presentation.briefing.readable(),
      // The `L` switch, so the harness can prove it suppresses the log rather
      // than merely toggling a field nothing reads.
      deckLog: presentation.briefing.enabled,
      death: session.death.phase,
      dock: session.docking.phase,
      // Hit-stop, so the harness can prove it dilates and then lets go. A
      // stuck timeScale is indistinguishable from the slow-motion bug that
      // has already cost an hour once.
      timeScale: +session.timeScale.toFixed(3),
      wave: session.wave,
      hostiles: fleet.hostiles.length,
      score: session.score,
      pending: session.pending,
      multiplier: +session.multiplier.toFixed(2),
      hull: +player.hull.toFixed(2),
      energy: +player.energy.toFixed(2),
      // The slab. `altitude` is the player's own height off the floor,
      // `hostileAltitude` the highest thing in the sector — enough for a
      // harness to prove that the ceiling is reachable, that letting go returns
      // you to the floor, that hostiles use it too, and that with `flight3d`
      // off nothing leaves the plane at all.
      altitude: +player.position.y.toFixed(2),
      climbing: player.climbing,
      diving: player.diving,
      era: eraSpec(campaign.era ?? DEFAULT_ERA).label,
      hostileAltitude: +fleet.hostiles
        .reduce((highest, h) => Math.max(highest, h.position.y), 0)
        .toFixed(2),
      flight3d: flight.threeD,
      ceiling: ALTITUDE.ceiling,
      // The Loom. `loom` is the phase, which is the encounter's whole state
      // machine — "none" / "weaving" / "sealed" / "fading". The rest is what a
      // harness needs to prove the four endings without watching: the wall's
      // height against the ceiling is the "can I still climb out" question,
      // the radius is the "has it started squeezing" question, and the spinner
      // count going to zero is the kill.
      loom: session.loom.phase,
      loomHeight: +session.loom.height.toFixed(2),
      loomSealed: session.loom.sealed,
      loomRadius: +session.loom.radius.toFixed(1),
      loomStrands: session.loom.strands.length,
      loomSpinners: session.loom.spinners.length,
      loomEnabled: encounters.loom,
      // The comet: which kind is standing here, if any, and how jammed the
      // player's own position is right now — the one number that gates
      // cloaks, fire-control and the scanner all at once. Enough for a
      // harness to prove one is seeded, that flying into it raises the
      // reading, and that flying back out lets it fall to zero again.
      comet: session.comet.plan?.kind ?? null,
      cometInterference: +interferenceAt(session.comet.plan, player.position.x, player.position.z).toFixed(3),
      torpedoes: player.torpedoes,
      debris: session.debris.count,
      mines: session.mines.count,
      cloaked: fleet.hostiles.filter((h) => h.hidden).length,
      // The ally, so a harness can prove one turns up at all and that a
      // garrisoned sector is met by the patrol it paid for. Null when the
      // sector is flying itself, which is most of the time.
      ally: session.escort?.callsign ?? null,
      allyDuty: session.escort?.duty ?? null,
      projectiles: session.ordnance.projectiles.length,
      fps: Math.round(smoothedFps),
      // The chart layer: which sector you're in, what's committed against the
      // front, and how far through a jump the charge is.
      hyperwarp: session.hyperwarp.phase,
      hyperwarpProgress: +session.hyperwarp.progress.toFixed(3),
      sector: campaign.current,
      inbound: campaign.incoming.length,
      // Distance now prices a jump, so a harness has to be able to see the
      // price it was quoted as well as the phase it reached.
      jumpSteps: jumpSteps(campaign.current, chartCursor),
      jumpCharge: +jumpCharge(campaign.current, chartCursor).toFixed(2),
      hyperwarpDuration: +session.hyperwarp.duration.toFixed(2),
      arrivalCard: +session.arrivalCard.toFixed(2),
      station: session.docking.stationName,
      // The overlay itself, so a headless harness can prove Tab actually
      // raises it and WASD actually steps the cursor, rather than only
      // re-reading a predicate the game already had to satisfy for some
      // other reason.
      chartOpacity: +chartOpacity.toFixed(3),
      chartCursor,
      // The campaign, so a harness can prove a run actually leads to another
      // one: salvage banked, the war's clock, what is standing and what is
      // fitted. `commandSelection` is what the command view has highlighted.
      salvage: Math.round(campaign.salvage),
      runsElapsed: campaign.runsElapsed,
      front: campaign.front,
      refits: campaign.refits.length,
      structures: campaign.sectors.reduce((n, s) => n + s.structures.length, 0),
      patrols: campaign.sectors.filter((s) => s.patrol).length,
      ours: campaign.sectors.filter((s) => s.control === "ours").length,
      commandSelection,
      // The sky, as one word and one number. Enough for a harness to prove the
      // two things that actually matter about it: that the same sector always
      // draws the same sky, and that a different one does not.
      sky: skyReport?.composition ?? null,
      skyBodies: skyReport?.bodies.length ?? 0,
    };
  }

  // The sky, stretched. Charging drives it most of the way and arrival kicks it
  // the rest, so the streaks peak just after the jump lands rather than during
  // the wind-up — the drama belongs to going somewhere, not to deciding to.
  const wantStretch = session.hyperwarp.charging
    ? 0.12 + session.hyperwarp.progress * 0.55
    : 0;
  if (session.arrivalFlash > 0) {
    warpStretch = Math.max(warpStretch, session.arrivalFlash);
  }
  // Rises fast and falls slowly: a snap into warp and a coast out of it.
  const rate = wantStretch > warpStretch ? 7 : 1.9;
  warpStretch += (wantStretch - warpStretch) * (1 - Math.exp(-rate * dt));
  starfield.stretch(warpStretch, player.heading);

  stage.render(dt);
  requestAnimationFrame(frame);
}

if (DEBUG_PROBE) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __stage: stage,
    __session: session,
    __player: player,
    __fleet: fleet,
    __wing: wing,
    __presentation: presentation,
    __campaign: campaign,
    // Grid geometry, re-exported rather than reimplemented, so the harness can
    // point the cursor at a real neighbour without duplicating the layout rules.
    __chart: { neighbours, indexOf, colOf, rowOf },
    // The next task's harness needs to set the destination directly — walking
    // WASD across the grid one keypress at a time is not worth simulating.
    __chartCursor: {
      get: () => chartCursor,
      set: (i: number) => {
        chartCursor = i;
      },
    },
    __sound: sound,
    /**
     * The Loom, summonable.
     *
     * It appears at a wave break with a one-in-ten chance from escalation index
     * four, which means a person tuning `LOOM.rise` would spend most of an
     * evening waiting for the thing they are tuning. This is the answer instead
     * of a key: the control surface is full, and a display toggle for something
     * that shows up once in fourteen waves is a binding spent on nothing.
     *
     * `seed()` opens one around the ship wherever it is standing; `weave.loom`
     * is the switch the encounter ships behind, so `__loom.weave.loom = false`
     * turns it off exactly the way `Y` turns the slab off.
     */
    __loom: {
      seed: () => session.seedLoom(player),
      collapse: () => session.loom.collapse(),
      model: session.loom,
      weave: encounters,
      constants: LOOM,
    },
    /**
     * The sky, and a way to flip through many of them without playing a war.
     *
     * There is deliberately no key for this — the control surface is full, and
     * a binding for something you only look at is a bad trade — so reviewing
     * sixty-four generated skies is otherwise a matter of jumping sixty-four
     * times. `pin` holds one up, `next`/`prev` walk the sectors, `unpin` hands
     * the sky back to the campaign, and each returns what it built so the
     * palette rule can be read off the console rather than guessed at.
     *
     *   __sky.pin(1, 0); __sky.next(); __sky.enabled = false; __sky.unpin();
     */
    __sky: {
      get enabled(): boolean {
        return backdrop.enabled;
      },
      set enabled(on: boolean) {
        backdrop.enabled = on;
      },
      pin: (seed: number, sector: number) => sky.pin(seed, sector),
      next: () => sky.cycle(1),
      prev: () => sky.cycle(-1),
      unpin: () => sky.unpin(),
      describe: () => sky.describe(),
    },
    /**
     * The comet, now wired into a run — `seed` and `model` are the session
     * side of it, the way `__loom.seed` and `__loom.model` are. `interferenceAt`,
     * `plan` and `constants` stay: they were never tied to the renderer or
     * session wiring, and `plan(seed, sector)` is still the pure, un-drawn way
     * to prove a sector's fixture is deterministic — the same sector gives the
     * same comet twice — without flying anywhere. `plan` still fixes
     * `sunAzimuth` at `null` deliberately, so what it returns depends on
     * `seed`/`sector` alone; a harness wanting the real bearing a run would use
     * reads it off `__probe.comet` instead.
     *
     * `seed()` drops a wanderer on the player — the same convenience
     * `__loom.seed()` gives someone tuning `COMET.wandererChance`, who would
     * otherwise wait for a rare roll past `COMET.earliest`.
     */
    __comet: {
      interferenceAt,
      plan: (seed: number, sector: number) => planFixture(seed, sector, null),
      constants: COMET,
      seed: () => session.seedComet(player),
      model: session.comet,
    },
    /**
     * The sector's star (`render/light.ts`) — pure maths. Neither `sun` nor
     * `sunFill` above is `GasGiant.body`'s light source — that shader reads
     * `uLightColor`/`vLightDirView` uniforms `giant.show` sets directly from
     * this same `SectorLight`, not the scene's `DirectionalLight` (see
     * `sun`'s own declaration for why the standing light stays anyway) — so
     * `shadeAt` currently lights nothing this run draws; it is the
     * per-stroke shading pass a future stroke-built body (the comet's head,
     * the ringed planet) still wants. Exposed here the same way
     * `__comet.plan`/`interferenceAt` are: a harness can prove `planLight` is
     * seeded and `shadeAt` is a real Lambertian term without flying anywhere
     * or waiting for a body to exist.
     */
    __light: { planLight, shadeAt },
    /**
     * The hero gas giant, exposed as the bare instance rather than wrapped in
     * a `{ model, constants }` object the way `__comet`/`__loom` are — the
     * brief's own harness (`tools/playtest.mjs`) reads `body`/`limb`/`object`
     * straight off it, so anything less direct
     * would just be a second name for the same calls.
     */
    __giant: giant,
    // The command view's own state, so a harness can point at a decision
    // without walking W twelve times.
    __command: {
      get selection() {
        return commandSelection;
      },
      set selection(i: number) {
        commandSelection = i;
      },
      get message() {
        return commandMessage;
      },
      decisions: DECISIONS,
    },
  });
}

requestAnimationFrame(frame);
