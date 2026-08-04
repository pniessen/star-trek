/**
 * The third dimension, shallow.
 *
 * "The play space is a plane" was a locked decision and it carried two loads,
 * neither of which held up:
 *
 *  - **The scanner.** Elite solved a 2D scanner over a 3D world in 1984 with a
 *    vertical stalk from every blip down to the plane, and Elite is in this
 *    project's own `prior-art.md`. Height reads instantly; you draw a line under
 *    it. The tube stays trustworthy — the *base* of the stalk is still exactly
 *    where the contact is.
 *  - **The four shield facings.** `Ship.facingFrom` resolves a hit with
 *    `atan2(x, z)` and has never looked at `y`. The facings are a **ring, not a
 *    sphere**: a shot from above at bearing 40 degrees already hits the same
 *    quarter a level shot from 40 degrees would. A cylinder is the correct
 *    model and it is what makes four facings survive a third dimension intact.
 *
 * What *did* hold up is the controls. Left/right yaw, up/down throttle, Space,
 * X, C, Z, Shift, Tab, R — both hands are full, and WASD has to stay identical
 * to the arrows. A second held axis has no fingers available. So there is no
 * second axis:
 *
 * **One key. Hold to rise, release to sink.** The plane is the *floor*, not the
 * middle. Rest is `y = 0`; holding `Q` climbs; letting go falls back. Descent is
 * not an input — it is what happens when you stop, which is the whole reason
 * this costs one binding instead of two. Nothing ever goes below the floor, so
 * a scanner stalk always points the same way, which is worth more than symmetry.
 *
 * Climbing draws on the one energy pool, exactly as thrust does. One pool is
 * locked and this must never become a second resource: altitude competing with
 * shields and with the next phaser shot *is* the mechanic. A dry reserve cannot
 * hold you up at all — run out and you sink, straight back onto the minefield
 * you were flying over.
 *
 * And it is **shallow**. Engagement happens between 14 and 78 units
 * (`preferredRange` across the five classes runs 14 to 62, `PHASER.falloffEnd`
 * is 78), so a ceiling around fourteen makes altitude a real evasive option
 * without turning a fight into a 3D search problem. It is also what lets the
 * guns train in elevation without the hull having to pitch — see
 * `Session.tubeAim`.
 *
 * Every number below is a first-draft guess of exactly the same species as
 * `Ship.TURN_ACCEL` or `PHASER.falloffEnd`. Nobody has flown any of it. They are
 * on the tuning list in `docs/todo.md` §2 for that reason.
 */
export const ALTITUDE = {
  /**
   * The lid. Roughly one Raider engagement range, which is the point: high
   * enough to break a minefield or change the shape of a pass, low enough that
   * a turret can still train on it and the tube can still show it.
   */
  ceiling: 14,
  /** Units per second while the key is held. ~1.6s from the floor to the lid. */
  climbRate: 9,
  /** Units per second once it is released. Faster than the climb: letting go should feel like letting go. */
  fallRate: 11,
  /**
   * Energy per second while the key is held — including while merely *holding*
   * altitude at the ceiling, because a lid you can park under for free is a lid
   * everybody parks under. Set against `Ship.THRUST_DRAIN` (0.035 at full burn):
   * staying up costs more than going fast, and a full reserve buys about
   * eighteen seconds of it.
   */
  drain: 0.055,
} as const;

/**
 * The switch, so it can be flown both ways.
 *
 * Nobody has flown this, so it ships behind a toggle rather than as a fact.
 * `Y` — for the Y axis — flips it, and `Y` is in `DISPLAY_KEYS` so pressing it
 * on the title screen changes the game rather than launching a run.
 *
 * **Off, the game is exactly what it was.** Every place that can put something
 * off the floor reads this and pins `y` to zero instead: the ship, every
 * hostile, every projectile. That is a structural guarantee rather than an
 * arithmetic one — with the slab off, nothing is ever asked to add zero.
 */
export const flight = {
  threeD: true,
};
