import { MathUtils, Vector3 } from "three";
import { Stage } from "./render/Stage.js";
import { VectorObject, type ShapeMode } from "./render/VectorObject.js";
import { TraceBuffer } from "./render/TraceBuffer.js";
import { PALETTE } from "./render/palette.js";
import {
  buildBastion,
  buildCruiser,
  buildHarrow,
  buildLance,
  buildRaider,
  buildShroud,
  buildStarbase,
} from "./geometry/hulls.js";
import { createGrid, createStarfield } from "./scene/environment.js";
import { Ship } from "./game/Ship.js";
import { Fleet, HOSTILE_COLORS, type HostileKind } from "./game/hostiles.js";
import { Session } from "./game/session.js";
import { Presentation } from "./game/presentation.js";
import type { DeathSequence } from "./game/death.js";
import { drawHud } from "./hud/draw.js";
import { load } from "./chart/persistence.js";
import { colOf, indexOf, inBounds, rowOf } from "./chart/sectors.js";

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
stage.scene.add(grid.object, createStarfield(), trace.object);

const HULLS = {
  cruiser: buildCruiser(),
  swarmer: buildRaider(),
  sniper: buildLance(),
  brawler: buildBastion(),
  miner: buildHarrow(),
  stalker: buildShroud(),
};

const player = new Ship();
const playerHull = new VectorObject(HULLS.cruiser, {
  color: PALETTE.trace,
  linewidth: 1.8,
}).addTo(stage.scene);

const fleet = new Fleet((kind: HostileKind) =>
  new VectorObject(HULLS[kind], {
    color: HOSTILE_COLORS[kind],
    linewidth: 1.4,
  }).addTo(stage.scene),
);

const STARBASE_POSITION = new Vector3(0, 0, 118);
const starbase = new VectorObject(buildStarbase(), {
  color: PALETTE.traceDim,
  linewidth: 1.5,
}).addTo(stage.scene);
starbase.group.position.copy(STARBASE_POSITION);

const session = new Session(fleet, STARBASE_POSITION, playerHull);
const presentation = new Presentation(session, player, fleet, STARBASE_POSITION);

// ── campaign ───────────────────────────────────────────────────────────────

// Loaded once at boot rather than on demand, so holding Tab the first time
// never stalls on a synchronous read. `load` never throws — a corrupt or
// absent save quietly becomes a fresh campaign.
const campaign = load(window.localStorage, Date.now());

/** Eased 0→1 while `Tab` is held. The overlay fades; the run behind it does not pause. */
let chartOpacity = 0;
/** The sector the chart cursor is pointing at, independent of `campaign.current`. */
let chartCursor = campaign.current;

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
const DISPLAY_KEYS = new Set(["g", "b", "f", "v", "h", "1", "2", "3", "[", "]", "-", "=", "tab"]);

/** Applied to every VectorObject in the scene, including ones spawned later. */
function applyShapeMode(): void {
  playerHull.setMode(settings.shape);
  starbase.setMode(settings.shape);
  for (const hostile of fleet.hostiles) hostile.shape.setMode(settings.shape);
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  // Tab's default is to move focus off the canvas, which would silently
  // strip every other key binding out from under the player.
  if (key === " " || key === "tab" || key.startsWith("arrow")) event.preventDefault();
  if (event.repeat) return;
  held.add(key);
  pressed.add(key);

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
    case "r":
      if (presentation.mode === "run") session.restart(player);
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

  // Any key takes the controls off the title screen or out of the demo.
  // Restarting from the death tally deliberately stays on R alone: a player
  // still holding fire as they die should not skip their own epitaph.
  if (presentation.mode !== "run" && !DISPLAY_KEYS.has(key)) presentation.startRun();
});
window.addEventListener("keyup", (event) => held.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => held.clear());
window.addEventListener("resize", () => stage.setSize(window.innerWidth, window.innerHeight));

applyShapeMode();

// ── camera ─────────────────────────────────────────────────────────────────

const forward = new Vector3();
const eye = new Vector3();
const focus = new Vector3();

function placeCamera(mode: CameraMode, time: number): void {
  player.forward(forward);
  const camera = stage.camera;

  if (mode === "cockpit") {
    // Sat exactly on the plane everything collapses onto a razor horizon; a
    // little height and a fractional look-down spreads the field enough to
    // read without pretending the play space has a third dimension.
    eye.copy(player.position).addScaledVector(forward, 1.1).setY(1.7);
    focus.copy(eye).addScaledVector(forward, 24).setY(0.2);
  } else if (mode === "chase") {
    eye.copy(player.position).addScaledVector(forward, -12).setY(4.6);
    focus.copy(player.position).addScaledVector(forward, 8).setY(0.4);
  } else {
    const angle = time * 0.28;
    eye.set(
      player.position.x + Math.sin(angle) * 15,
      4.2 + Math.sin(time * 0.4) * 1.2,
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

  eye.set(
    death.wreck.x + Math.sin(angle) * MathUtils.lerp(12, 52, t),
    MathUtils.lerp(1.8, 24, t),
    death.wreck.z + Math.cos(angle) * MathUtils.lerp(12, 52, t),
  );
  focus.copy(death.wreck).setY(MathUtils.lerp(0.6, 0, t));

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

  // The chart is an overlay on top of the run, not a pause of it — it fades on
  // its own clock using real `dt` so the ease reads the same on any machine.
  chartOpacity = approach(chartOpacity, held.has("tab") ? 1 : 0, dt, CHART_FADE_RATE);
  // Past the midpoint of the fade WASD is reading the map, not flying the
  // ship. Below it, control hands straight back — there is no separate mode
  // to get stuck in, just where this one number happens to be.
  const chartActive = chartOpacity > 0.5;
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

  if (presentation.mode === "title") {
    // Nothing is flown and no wave is spawned behind the title — the session is
    // not stepped at all. The hull just turns on the spot so it presents
    // itself, which is the whole of what the title screen asks of the sim.
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

    // The station takes the helm during capture, and holds you in place while
    // moored — you can still turn and shoot, which is what stops a wave arriving
    // mid-dock from being a helpless mauling.
    const dock = session.docking;
    if (alive && !dock.controlsLocked) {
      const departing = dock.clearing ? Math.min(thrust, 0) : thrust;
      player.update({ turn, thrust: dock.held ? 0 : departing, held: dock.held }, gameDt);
    }

    session.update(dt, player, {
      firePhaser: alive && (demo ? demo.firePhaser : held.has(" ") || pressed.has(" ")),
      fireTorpedo: alive && (demo ? demo.fireTorpedo : held.has("x") || pressed.has("x")),
      thrust: alive && thrust > 0,
    });
  }
  pressed.clear();

  // Newly spawned hostiles have to inherit the current geometry mode.
  for (const hostile of fleet.hostiles) hostile.shape.setMode(settings.shape);

  playerHull.group.position.copy(player.position);
  playerHull.group.rotation.set(0, player.heading, player.bank * 0.6);
  // On the title screen the hull is the subject whatever the camera mode says;
  // once it has become debris there is nothing left to draw.
  playerHull.group.visible =
    presentation.mode === "title" ||
    (settings.camera !== "cockpit" && !session.death.hidesHull);
  starbase.group.rotation.y = time * 0.06;

  trace.begin();
  session.ordnance.draw(trace);
  session.mines.draw(trace, player);
  session.debris.draw(trace);
  session.death.draw(trace);
  session.docking.draw(trace, player);
  trace.end();

  grid.follow(player.position.x, player.position.z);

  if (session.death.phase !== "none") placeWreckCamera(session.death, time);
  else if (presentation.mode === "title") placeTitleCamera(time);
  else placeCamera(settings.camera, time);

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
    shapeMode: settings.shape,
    bloom: settings.bloom,
    phosphor: settings.phosphor,
    crt: settings.crt,
    showDiagnostics: settings.diagnostics,
    campaign,
    chartOpacity,
    chartCursor,
  });

  if (DEBUG_PROBE) {
    (window as unknown as Record<string, unknown>).__probe = {
      state: session.state,
      // The shell around the run — "title" / "attract" / "run". `state` still
      // means what it always did; a title screen is not a phase of combat.
      mode: presentation.mode,
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
      torpedoes: player.torpedoes,
      debris: session.debris.count,
      mines: session.mines.count,
      cloaked: fleet.hostiles.filter((h) => h.hidden).length,
      projectiles: session.ordnance.projectiles.length,
      fps: Math.round(smoothedFps),
    };
  }

  stage.render(dt);
  requestAnimationFrame(frame);
}

if (DEBUG_PROBE) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __stage: stage,
    __session: session,
    __player: player,
    __fleet: fleet,
    __presentation: presentation,
  });
}

requestAnimationFrame(frame);
