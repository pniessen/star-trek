import type { Color, Vector3 } from "three";
import type { DecayCurve } from "../render/eventLights.js";

/**
 * How a combat effect asks the world to be lit, without knowing what is
 * listening.
 *
 * `render/eventLights.ts` is a pool of real `PointLight`s and its `flash` is a
 * six-argument method on a class that has to be constructed once, at boot,
 * before any lit material draws (see that file's header — constructing it *is*
 * the shader recompile). The three effect modules here — `shieldFx`,
 * `weapons`, `warpFx` — are none of them in a position to own one: two of them
 * are free functions called from the draw loop and the third is a projectile
 * bag owned by `Session`. Handing each of them an `EventLights` reference would
 * mean three modules that cannot be reasoned about, drawn, or unit-tested
 * without a scene graph behind them.
 *
 * So they take this instead: one optional callback, in exactly `flash`'s own
 * argument order, so wiring it at the call site is
 * `(at, colour, i, s, curve) => lights.flash(at, colour, i, s, { curve })` and
 * nothing has to be kept in agreement beyond that one line.
 *
 * **`at` and `color` are borrowed, not given.** An implementation must read
 * them during the call and never retain them — `EventLights.arm` copies both
 * into the light's own objects, which is what lets the emitters here pass a
 * scratch vector from the middle of a draw loop rather than cloning one per
 * explosion. A sink that stores the reference is holding a value that will be
 * overwritten by the next flash in the same frame.
 *
 * **Optional everywhere it is accepted.** Every effect in this game has to look
 * right with no lights at all: the standalone build, the playtest harness and
 * every frame before `main.ts` finishes wiring the pool all draw through the
 * same code, and an effect that is only legible once a `PointLight` reaches it
 * would be an effect that is invisible in three of the places it runs. The
 * strokes carry the event; the light is what the event does to the room.
 */
export type LightSink = (
  at: Vector3,
  color: Color,
  intensity: number,
  seconds: number,
  curve: DecayCurve,
) => void;
