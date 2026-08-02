import { Color, MathUtils, Vector3 } from "three";
import { Stage } from "./render/Stage.js";
import { VectorObject, type ShapeMode } from "./render/VectorObject.js";
import { PALETTE } from "./render/palette.js";
import { buildCruiser, buildInterceptor, buildStarbase } from "./geometry/hulls.js";
import { createGrid, createStarfield } from "./scene/environment.js";
import { Ship, FACINGS } from "./game/Ship.js";

/** Publishes camera and entity state on `window.__probe` for headless checks. */
const DEBUG_PROBE = location.hostname === "127.0.0.1" || location.hostname === "localhost";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const fault = document.getElementById("fault") as HTMLDivElement;

function fail(error: unknown): never {
  fault.style.display = "grid";
  fault.textContent = `RENDERER FAULT\n\n${error instanceof Error ? error.stack ?? error.message : String(error)}`;
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
const starfield = createStarfield();
stage.scene.add(grid.object, starfield);

if (DEBUG_PROBE) {
  Object.assign(window as unknown as Record<string, unknown>, { __stage: stage, __starfield: starfield });
}

const cruiserGeometry = buildCruiser();
const interceptorGeometry = buildInterceptor();

const player = new Ship();
const playerHull = new VectorObject(cruiserGeometry, {
  color: PALETTE.trace,
  linewidth: 1.8,
}).addTo(stage.scene);

interface Hostile {
  readonly shape: VectorObject;
  readonly origin: Vector3;
  readonly orbit: number;
  readonly rate: number;
  readonly phase: number;
}

// Deliberately clustered and overlapping — the whole point of the comparison is
// what happens when hulls cross in front of one another.
const hostiles: Hostile[] = [
  { at: new Vector3(2, 0, 30), orbit: 6, rate: 0.32, phase: 0 },
  { at: new Vector3(13, 0, 36), orbit: 5, rate: -0.44, phase: 1.9 },
  { at: new Vector3(-8, 0, 33), orbit: 5, rate: 0.51, phase: 3.4 },
  { at: new Vector3(4, 0, 48), orbit: 9, rate: -0.27, phase: 0.8 },
  { at: new Vector3(-22, 0, 26), orbit: 4, rate: 0.61, phase: 2.2 },
  { at: new Vector3(24, 0, 22), orbit: 4, rate: -0.55, phase: 5.1 },
].map(({ at, orbit, rate, phase }) => {
  const shape = new VectorObject(interceptorGeometry, {
    color: PALETTE.amber,
    linewidth: 1.4,
  }).addTo(stage.scene);
  // Interceptors are smaller craft, but not so small that they collapse to a
  // bloom smear at engagement range.
  shape.group.scale.setScalar(1.5);
  return { shape, origin: at, orbit, rate, phase };
});

const starbase = new VectorObject(buildStarbase(), {
  color: PALETTE.traceDim,
  linewidth: 1.5,
}).addTo(stage.scene);
starbase.group.position.set(-70, 0, 96);

const allShapes: VectorObject[] = [playerHull, starbase, ...hostiles.map((h) => h.shape)];

// ── controls ───────────────────────────────────────────────────────────────

const CAMERA_MODES = ["cockpit", "chase", "orbit"] as const;
type CameraMode = (typeof CAMERA_MODES)[number];

const settings = {
  shape: "occluded" as ShapeMode,
  camera: "chase" as CameraMode,
  bloom: true,
  phosphor: true,
  crt: true,
  hud: true,
};

const held = new Set<string>();

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  held.add(key);

  switch (key) {
    case "g":
      settings.shape = settings.shape === "occluded" ? "wireframe" : "occluded";
      for (const shape of allShapes) shape.setMode(settings.shape);
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
      settings.hud = !settings.hud;
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

for (const shape of allShapes) shape.setMode(settings.shape);

window.addEventListener("resize", () => stage.setSize(window.innerWidth, window.innerHeight));

// ── camera rigs ────────────────────────────────────────────────────────────

const forward = new Vector3();
const eye = new Vector3();
const focus = new Vector3();

function placeCamera(mode: CameraMode, time: number): void {
  player.forward(forward);
  const camera = stage.camera;

  if (mode === "cockpit") {
    // Sat exactly on the plane, everything collapses onto a razor horizon.
    // A little height and a fractional look-down spreads the field out enough
    // to read without pretending the play space has a third dimension.
    eye.copy(player.position).addScaledVector(forward, 1.1).setY(1.7);
    focus.copy(eye).addScaledVector(forward, 24).setY(0.2);
  } else if (mode === "chase") {
    eye.copy(player.position).addScaledVector(forward, -10.5).setY(3.6);
    focus.copy(player.position).addScaledVector(forward, 8).setY(0.4);
  } else {
    const angle = time * 0.28;
    eye.set(
      player.position.x + Math.sin(angle) * 13,
      3.4 + Math.sin(time * 0.4) * 1.2,
      player.position.z + Math.cos(angle) * 13,
    );
    focus.copy(player.position);
  }

  camera.position.copy(eye);
  camera.up.set(0, 1, 0);
  camera.lookAt(focus);
  camera.rotateZ(player.bank * (mode === "cockpit" ? 1 : 0.55));
}

// ── HUD drawing ────────────────────────────────────────────────────────────

const hud = stage.hud;
const dimTrace = PALETTE.trace.clone().multiplyScalar(0.55);
const shieldColor = new Color();

function arc(
  out: number[],
  cx: number,
  cy: number,
  radius: number,
  from: number,
  to: number,
  steps: number,
): void {
  for (let i = 0; i < steps; i++) {
    const a0 = MathUtils.lerp(from, to, i / steps);
    const a1 = MathUtils.lerp(from, to, (i + 1) / steps);
    out.push(
      cx + Math.cos(a0) * radius,
      cy + Math.sin(a0) * radius,
      cx + Math.cos(a1) * radius,
      cy + Math.sin(a1) * radius,
    );
  }
}

function pad(value: number, width: number): string {
  return Math.round(value).toString().padStart(width, "0");
}

function drawHud(fps: number): void {
  const { width, height } = hud.size;
  hud.begin();

  // Frame the screen — reads as an instrument bezel, and it is four segments.
  hud.brackets(18, 18, width - 36, height - 36, 22, PALETTE.traceDim);

  // Identity and mode, top left.
  hud.text("KOBAYASHI", 34, height - 48, 3.4, PALETTE.trace);
  hud.text("RENDERER PROTOTYPE", 34, height - 68, 1.5, PALETTE.traceDim);

  const toggles: [string, boolean | string][] = [
    ["G  GEOMETRY", settings.shape.toUpperCase()],
    ["B  BLOOM", settings.bloom],
    ["F  PHOSPHOR", settings.phosphor],
    ["V  CRT GLASS", settings.crt],
    ["1/2/3  VIEW", settings.camera.toUpperCase()],
  ];
  toggles.forEach(([label, state], index) => {
    const y = height - 108 - index * 20;
    const on = state === true || typeof state === "string";
    hud.text(label, 34, y, 1.6, on ? dimTrace : PALETTE.traceDim);
    const value = typeof state === "string" ? state : state ? "ON" : "OFF";
    hud.text(
      value,
      190,
      y,
      1.6,
      typeof state === "string" ? PALETTE.trace : state ? PALETTE.trace : PALETTE.traceDim,
    );
  });

  hud.text(
    `[ ]  DECAY ${stage.phosphor.decay.toFixed(2)}    -/=  BLOOM ${stage.bloom.strength.toFixed(2)}`,
    34,
    height - 232,
    1.4,
    PALETTE.traceDim,
  );

  // Shield facings, top centre. Four arcs, brightness is charge — a glance
  // tells you which way to turn before any number does.
  const sx = width / 2;
  const sy = height - 86;
  FACINGS.forEach((facing, index) => {
    const charge = player.shields[facing];
    const segments: number[] = [];
    // Wide gaps: four separate arcs have to read as four separate shields at a
    // glance. Close them up and the whole thing becomes one ring.
    const centre = Math.PI / 2 - index * (Math.PI / 2);
    arc(segments, sx, sy, 32, centre - Math.PI / 4 + 0.24, centre + Math.PI / 4 - 0.24, 6);
    shieldColor.copy(charge < 0.3 ? PALETTE.amber : PALETTE.trace).multiplyScalar(
      0.25 + charge * 0.75,
    );
    hud.segments(segments, shieldColor);
  });
  // A ship glyph in the middle, so "which arc is my bow" needs no label.
  hud.segments(
    [sx, sy + 9, sx - 6, sy - 7, sx - 6, sy - 7, sx, sy - 3, sx, sy - 3, sx + 6, sy - 7, sx + 6, sy - 7, sx, sy + 9],
    PALETTE.traceDim,
  );
  hud.textRight("SHIELDS", sx - 46, sy - 4, 1.5, PALETTE.traceDim);

  // Reticle, cockpit only — brackets, never a crosshair over the whole screen.
  if (settings.camera === "cockpit") {
    const cx = width / 2;
    const cy = height / 2;
    const gap = 26;
    const arm = 14;
    hud.segments(
      [
        cx - gap, cy, cx - gap - arm, cy,
        cx + gap, cy, cx + gap + arm, cy,
        cx, cy - gap, cx, cy - gap - arm,
        cx, cy + gap, cx, cy + gap + arm,
      ],
      PALETTE.amber,
    );
  }

  // Ship state, bottom left.
  hud.text("ENERGY", 34, 92, 1.6, PALETTE.traceDim);
  hud.gauge(
    34,
    64,
    220,
    18,
    player.energy,
    player.energy < 0.25 ? PALETTE.amber : PALETTE.trace,
    5,
  );
  hud.text(`${pad(player.energy * 100, 3)}%`, 264, 68, 1.9, PALETTE.trace);

  hud.text("SPD", 34, 38, 1.5, PALETTE.traceDim);
  hud.text(pad(player.speed, 3), 66, 36, 2.1, PALETTE.trace);
  hud.text("BRG", 130, 38, 1.5, PALETTE.traceDim);
  hud.text(`${pad(player.bearing, 3)}°`, 162, 36, 2.1, PALETTE.trace);

  // Diagnostics, bottom right.
  hud.textRight(`${pad(fps, 3)} FPS`, width - 34, 38, 1.5, PALETTE.traceDim);
  hud.textRight("ARROWS / WASD  TURN + THRUST", width - 34, 60, 1.5, PALETTE.traceDim);

  hud.end();
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

  const turn = (held.has("arrowright") || held.has("d") ? 1 : 0) -
    (held.has("arrowleft") || held.has("a") ? 1 : 0);
  const thrust = (held.has("arrowup") || held.has("w") ? 1 : 0) -
    (held.has("arrowdown") || held.has("s") ? 1 : 0);

  player.update({ turn, thrust }, dt);

  playerHull.group.position.copy(player.position);
  playerHull.group.rotation.set(0, player.heading, player.bank * 0.6);
  playerHull.group.visible = settings.camera !== "cockpit";

  for (const hostile of hostiles) {
    const angle = time * hostile.rate + hostile.phase;
    hostile.shape.group.position.set(
      hostile.origin.x + Math.cos(angle) * hostile.orbit,
      0,
      hostile.origin.z + Math.sin(angle) * hostile.orbit,
    );
    // Nose along the tangent — they read as flying, not sliding.
    hostile.shape.group.rotation.set(0, angle + Math.PI / 2 * Math.sign(hostile.rate), 0);
  }

  starbase.group.rotation.y = time * 0.06;

  grid.follow(player.position.x, player.position.z);
  placeCamera(settings.camera, time);

  if (DEBUG_PROBE) {
    (window as unknown as Record<string, unknown>).__probe = {
      camera: stage.camera.position.toArray().map((n) => n.toFixed(2)),
      player: player.position.toArray().map((n) => n.toFixed(2)),
      hullVisible: playerHull.group.visible,
      mode: settings.camera,
      hostile0: hostiles[0].shape.group.position.toArray().map((n) => n.toFixed(1)),
    };
  }

  stage.hud.scene.visible = settings.hud;
  if (settings.hud) drawHud(smoothedFps);

  stage.render(dt);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
