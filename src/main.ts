import { Vector3 } from "three";
import { Stage } from "./render/Stage.js";
import { VectorObject, type ShapeMode } from "./render/VectorObject.js";
import { TraceBuffer } from "./render/TraceBuffer.js";
import { PALETTE } from "./render/palette.js";
import { buildBrawler, buildCruiser, buildInterceptor, buildStarbase } from "./geometry/hulls.js";
import { createGrid, createStarfield } from "./scene/environment.js";
import { Ship } from "./game/Ship.js";
import { Fleet, type HostileKind } from "./game/hostiles.js";
import { Session } from "./game/session.js";
import { drawHud } from "./hud/draw.js";

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
  interceptor: buildInterceptor(),
  brawler: buildBrawler(),
};

const player = new Ship();
const playerHull = new VectorObject(HULLS.cruiser, {
  color: PALETTE.trace,
  linewidth: 1.8,
}).addTo(stage.scene);

const fleet = new Fleet((kind: HostileKind) =>
  new VectorObject(kind === "brawler" ? HULLS.brawler : HULLS.interceptor, {
    color: PALETTE.amber,
    linewidth: 1.4,
  }).addTo(stage.scene),
);

const STARBASE_POSITION = new Vector3(0, 0, 118);
const starbase = new VectorObject(buildStarbase(), {
  color: PALETTE.traceDim,
  linewidth: 1.5,
}).addTo(stage.scene);
starbase.group.position.copy(STARBASE_POSITION);

const session = new Session(fleet, STARBASE_POSITION);

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

/** Applied to every VectorObject in the scene, including ones spawned later. */
function applyShapeMode(): void {
  playerHull.setMode(settings.shape);
  starbase.setMode(settings.shape);
  for (const hostile of fleet.hostiles) hostile.shape.setMode(settings.shape);
}

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (key === " " || key.startsWith("arrow")) event.preventDefault();
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
      session.restart(player);
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

// ── loop ───────────────────────────────────────────────────────────────────

let last = performance.now();
let time = 0;
let smoothedFps = 60;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;
  smoothedFps += (1 / Math.max(dt, 1e-4) - smoothedFps) * 0.08;

  const alive = session.state !== "dead";
  const turn =
    (held.has("arrowright") || held.has("d") ? 1 : 0) -
    (held.has("arrowleft") || held.has("a") ? 1 : 0);
  const thrust =
    (held.has("arrowup") || held.has("w") ? 1 : 0) -
    (held.has("arrowdown") || held.has("s") ? 1 : 0);

  if (alive) player.update({ turn, thrust }, dt);

  session.update(dt, player, {
    firePhaser: alive && (held.has(" ") || pressed.has(" ")),
    fireTorpedo: alive && (held.has("x") || pressed.has("x")),
  });
  pressed.clear();

  // Newly spawned hostiles have to inherit the current geometry mode.
  for (const hostile of fleet.hostiles) hostile.shape.setMode(settings.shape);

  playerHull.group.position.copy(player.position);
  playerHull.group.rotation.set(0, player.heading, player.bank * 0.6);
  playerHull.group.visible = settings.camera !== "cockpit" && alive;
  starbase.group.rotation.y = time * 0.06;

  trace.begin();
  session.ordnance.draw(trace);
  session.debris.draw(trace);
  trace.end();

  grid.follow(player.position.x, player.position.z);
  placeCamera(settings.camera, time);

  drawHud(stage.hud, {
    player,
    session,
    fleet,
    starbase: STARBASE_POSITION,
    fps: smoothedFps,
    time,
    cameraMode: settings.camera,
    shapeMode: settings.shape,
    bloom: settings.bloom,
    phosphor: settings.phosphor,
    crt: settings.crt,
    showDiagnostics: settings.diagnostics,
  });

  if (DEBUG_PROBE) {
    (window as unknown as Record<string, unknown>).__probe = {
      state: session.state,
      wave: session.wave,
      hostiles: fleet.hostiles.length,
      score: session.score,
      pending: session.pending,
      multiplier: +session.multiplier.toFixed(2),
      hull: +player.hull.toFixed(2),
      energy: +player.energy.toFixed(2),
      torpedoes: player.torpedoes,
      debris: session.debris.count,
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
  });
}

requestAnimationFrame(frame);
