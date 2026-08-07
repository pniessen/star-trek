import { MathUtils, Vector3 } from "three";
import { Stage } from "./render/Stage.js";
import { VectorObject, type ShapeMode } from "./render/VectorObject.js";
import { TraceBuffer } from "./render/TraceBuffer.js";
import { Backdrop, backdrop } from "./render/Backdrop.js";
import { PALETTE } from "./render/palette.js";
import {
  buildBastion,
  buildCruiser,
  buildHarrow,
  buildLance,
  buildRaider,
  buildShroud,
  buildStarbase,
  buildWarden,
} from "./geometry/hulls.js";
import { createGrid, createStarfield } from "./scene/environment.js";
import { Ship } from "./game/Ship.js";
import { ALTITUDE, flight } from "./game/altitude.js";
import { Fleet, HOSTILE_COLORS, type HostileKind } from "./game/hostiles.js";
import { Wing } from "./game/allies.js";
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
const starfield = createStarfield();
// The sky of whichever sector the run is in. Added once and then only ever
// rebuilt in place; it draws between the starfield and the grid and is pinned
// to the camera's position every frame. See `render/Backdrop.ts`.
const sky = new Backdrop();
stage.scene.add(grid.object, starfield.object, trace.object, sky.object);

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
};

const player = new Ship();
const playerHull = new VectorObject(HULLS.cruiser, {
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
 * The one place the browser's storage is named. Everything below hands this to
 * whoever needs to persist, so the campaign rules stay free of the DOM and a
 * test can substitute a plain object.
 */
const persist = (state: Campaign): void => save(state, window.localStorage);

const session = new Session(fleet, wing, STARBASE_POSITION, playerHull, campaign);
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
const DISPLAY_KEYS = new Set(["g", "b", "f", "v", "h", "l", "m", "y", "1", "2", "3", "[", "]", "-", "=", "tab"]);

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

/** Applied to every VectorObject in the scene, including ones spawned later. */
function applyShapeMode(): void {
  playerHull.setMode(settings.shape);
  starbase.setMode(settings.shape);
  for (const hostile of fleet.hostiles) hostile.shape.setMode(settings.shape);
  wing.escort?.shape.setMode(settings.shape);
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

  eye.set(
    player.position.x + Math.sin(angle) * 21,
    5.6 + Math.sin(time * 0.23) * 1.8,
    player.position.z + Math.cos(angle) * 21,
  );
  focus.copy(player.position).setY(0.6);

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
    if (pressed.has("w")) nextRow -= 1;
    else if (pressed.has("s")) nextRow += 1;
    else if (pressed.has("a")) nextCol -= 1;
    else if (pressed.has("d")) nextCol += 1;
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

    // WASD flies the ship, except while the chart is up, where the same keys
    // step the cursor instead — see above. The arrows are never reassigned,
    // so a player who wants to keep manoeuvring while reading the chart can.
    const turn = demo
      ? demo.turn
      : (held.has("arrowright") || (!chartActive && held.has("d")) ? 1 : 0) -
        (held.has("arrowleft") || (!chartActive && held.has("a")) ? 1 : 0);
    const thrust = demo
      ? demo.thrust
      : (held.has("arrowup") || (!chartActive && held.has("w")) ? 1 : 0) -
        (held.has("arrowdown") || (!chartActive && held.has("s")) ? 1 : 0);
    // The engine bed reads the same thrust the flight model does, so reading
    // the map does not make the ship sound like it is still burning.
    burn = Math.max(0, thrust);

    // Altitude, on one key. `Q` because it is free, because it sits directly
    // above `A` for a WASD flyer's little finger, and because an arrows flyer's
    // left hand is already parked one row down on Z/X/C. Deliberately *not*
    // remapped while the chart is up, exactly as the arrows are not: it is a
    // flight control, and pulling the chart up over a minefield is precisely
    // when you want to still be able to climb. The demo pilot never asks for
    // it — see `Presentation.fly`.
    const climb = demo ? false : held.has("q");

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
        { turn, thrust: dock.held ? 0 : departing, climb, held: dock.held },
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
      // Held, not tapped: pouring the reserve into a facing is a thing you do
      // for as long as you dare, and letting go is how you stop.
      reinforce: alive && !demo && held.has("z"),
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
  // does a Warden that arrived after the last time `G` was pressed.
  for (const hostile of fleet.hostiles) hostile.shape.setMode(settings.shape);
  wing.escort?.shape.setMode(settings.shape);

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
  starbase.group.rotation.y = time * 0.06;

  trace.begin();
  session.ordnance.draw(trace);
  session.mines.draw(trace, player);
  session.debris.draw(trace);
  session.death.draw(trace);
  session.docking.draw(trace, player);
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
      hostileAltitude: +fleet.hostiles
        .reduce((highest, h) => Math.max(highest, h.position.y), 0)
        .toFixed(2),
      flight3d: flight.threeD,
      ceiling: ALTITUDE.ceiling,
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
