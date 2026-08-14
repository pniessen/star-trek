# The Combat Experience — design

*Written 2026-08-13, approved in conversation before implementation. Companion
to [2026-08-13-broken-invasion-design.md](2026-08-13-broken-invasion-design.md):
the commander's guard (§2.3 here) is the one in-run appearance of the commander
that spec deliberately deferred to this one.*

Two packs, chosen from a wider list in conversation. Explicitly **not**
included, by the owner's ruling: the tuning session (skipped for now, though
`todo.md` §2 still names it the highest-value combat work), command-detonate
torpedoes (deferred — it earns its own spec if ever taken), FOV/speed
legibility (rides with the environment plan's mote layer instead), mouse aim,
lock-on, and any new weapon or keybinding. The control surface is full and
stays full: nothing in this document adds an input.

House constraints that bind everything here: transient strokes go through
`TraceBuffer`; colour is information and no new hue is introduced; every sound
goes through the synth's two voices and may never throw; everything decays on
`dt`; hit-stop remains the only thing that scales game time.

---

## 1. The feel pack

Three changes that make existing skill legible. No mechanics change; every
number the combat model computes today is untouched.

### 1.1 Near-miss language

The moment the player dodges best, the game currently says nothing: a bolt
that misses simply expires. `weapons.ts` already computes `sweepDistance` per
projectile per frame; a hostile projectile whose closest approach to the
player this frame falls inside a near-miss band (outside the hit radius,
inside roughly 3–5 units — implementation tunes the band) triggers, once per
projectile (a flag on `Projectile`):

- **A streak:** a short-lived `TraceBuffer` stroke along the projectile's
  travel direction at the point of closest approach, in the bolt's own amber,
  brighter than the bolt itself for a few tenths of a second — the "it went
  *past* you" line.
- **A doppler sweep:** a filtered-noise whoosh through the existing noise
  voice, panned by the miss's position like `hostileFire` already is. New cue
  in `sound.ts`, in the bank's existing idiom, with the standard
  may-never-throw guard.

The player's own shots get neither — a near miss on a hostile is just a miss,
and rewarding it would teach spray. Torpedo near-misses on the player do get
it (they are the shots most worth having visibly survived). Rate-limited to
one cue per short window so a Raider volley is one whoosh, not four.

This is the change the altitude slab has been waiting for: ducking under a
shot is currently indistinguishable from the shot having been aimed wrong.

### 1.2 World-space shield language

The four facings are the game's central skill and live only in the HUD dial.
Two additions, both read off state `Ship` already keeps:

- **Struck-quarter flash.** `applyDamage` already resolves the facing. It
  additionally records the struck facing and a decaying timer (a small,
  render-facing field on `Ship`, the same pattern as `Hostile.flash`); the
  renderer draws a brief arc segment around the player's hull at that
  quarter's bearing — a 90° `TraceBuffer` arc, cyan like everything ours,
  intensity from the timer. Where the shot landed becomes visible in the
  world, at the ship, where the player is looking.
- **Brace aura.** While the bow holds more than 1 facing's worth (the
  overcharge `BRACE` creates and leaks), a steady bow arc glows with
  intensity proportional to the surplus. The brace's nine-second window
  becomes something the player can *see* draining instead of inferring, and
  the "keep the shooter on your nose" posture gets its visual anchor. Same
  arc machinery as the flash; the two compose (a hit on a braced bow flashes
  over the aura).

Chase and orbit cameras see both naturally; in cockpit view the arcs sit at
the screen edge like the hull does. No HUD change — the dial stays, this is
the world agreeing with it.

### 1.3 Kill punctuation by class

Debris-of-own-edges stays exactly as it is. On top of it, `Session.destroy`
adds an expanding `TraceBuffer` ring at the kill position — in the dead
class's own hue, radius and brightness scaled by the class's `radius`/`value`
so a Bastion or Harrow death reads categorically bigger than a Raider pop —
and Bastion/Harrow kills additionally fire a slightly stronger hit-stop tick
through the existing bounded `HIT_STOP` system (no new time scale, no frame
freeze; the existing rules on `Session.timeScale` are untouched). Spinner and
mine deaths keep their current presentation.

The ring never pulses or throbs — it expands and dies inside a second, which
keeps it on the right side of "pulse and flash stay reserved for hostiles'
*behaviour*": it is an obituary, not a signal.

---

## 2. The hostile doctrine pack

Three changes that make the classes fight as a team and tie combat to the
war. These do change mechanics, each in one bounded way.

### 2.1 Facing-aware flanking

When a Bastion (brawler) is alive and holding the player's forward arc,
Raiders (swarmers) bias toward the player's rear quarters: the strafe
tangent's sign — today a positional hash in `Hostile.update` — becomes, for
swarmers only and only while a brawler is engaged at range, the sign that
carries the swarmer toward the player's stern bearing, and the range-hold
gains a mild preference for station-keeping behind the player's beam.

The point is to attack the *decision* the four facings create: turn to
protect the stern and the bow leaves the Bastion; brace and the stern is
paid for. The bias is a steering preference, not a new brain — bounded so a
swarmer never orbits harder than `orbit` already lets it, and inert when no
brawler is up, so wave-one behaviour is unchanged. Other classes are
untouched: the Lance's perch, the Harrow's crossing runs and the Shroud's
knife are their own personalities and flanking would blur them.

Perceivable and honest: the scanner already shows it happening, and the
first time a stern quarter drops while the bow is braced, the lesson is the
game's own — that is the four-facing skill sharpened again, in exactly the
direction `BRACE`'s design says the game should press.

### 2.2 Withdrawal

A hostile whose hull falls below a withdrawal threshold (~20%, per class
judgement at implementation; the Shroud is exempt — its whole class is
already an exit) breaks off: it turns away from the player, runs at full
speed, stops firing, and after clearing a generous range performs the
hostiles' own version of a hyperwarp exit — a stretch-and-flash in its own
hue, the reverse of the Shroud's reveal grammar — and is removed. **An
escaped hostile pays nothing**: no salvage, no multiplier, no kill count, no
tally entry — the Warden's no-payment precedent, applied to cowardice. It
does not count against wave clearance either; the wave ends when everything
is dead *or gone*, so a withdrawal never strands a run waiting on a fled
ship.

The mid-fight decision this buys is the game's own currency: chase the
cripple and its salvage, or hold position against the pack. The multiplier
is not touched by an escape — the price of letting it go is purely the
foregone gain, which keeps the mechanic a greed question rather than a
punishment.

The HUD label of a withdrawing hostile gains a `WITHDRAWING` tag on the line
it already owns, because a retreat the player cannot distinguish from a
strafing run is a mechanic that does not exist. Frequency guard: withdrawal
rolls once, at the threshold crossing, with a per-class chance
(Raiders likely, Bastions rarely — an anvil that runs stops being an anvil),
so most fights still end in kills and the tally stays the run's story.

### 2.3 The commander's guard

The Broken Invasion spec's commander steps into the run, once the war is old
enough — and only as a stat-and-name variant, never a new hull or behaviour:

- **When:** in the war's *failing* act (the reserve running dry), waves roll
  a small chance of including one **guard** — a veteran of the commander's
  own doctrine: the Raider doctrine fields a guard swarmer, the Hammer a
  guard brawler, the Anvil a guard sniper.
- **What:** the class's spec with modest multipliers (more hull, a touch
  more speed or damage — implementation picks one axis per doctrine rather
  than raising everything), `value` scaled up to pay for the fight, and the
  label the class already draws carrying the commander's surname
  ("VOL'S GUARD"). Same hue as its class — colour is information and the
  class *is* the information; the name and the fight are what distinguish
  it.
- **Why here:** it makes the war's endgame legible inside the run — the
  enemy spending its best — and it is the cheapest true sentence the combat
  layer can say about the campaign. It never appears in attract mode's
  throwaway campaign progression beyond what that campaign's own state
  earns, which the act gate already guarantees.

No flagship, no boss bar, no scripted encounter — the guard is a wave
member, killable by the same play, worth more, and gone when the war ends.

---

## 3. Segment budget

Everything in §1 rides `TraceBuffer` transients: a near-miss streak is a few
segments, a shield arc a dozen, a kill ring a few dozen for under a second.
Against the shared 5000 (comet: 779) this is noise, but the counts get
measured and recorded in `todo.md` the way the comet's were — and if the
environment plan's own budget question (its §5.1: a second, scenery
`TraceBuffer`) has been answered by the time this lands, combat transients
stay in the combat buffer.

## 4. Testing

- **`playtest`:** a withdrawing hostile leaves and pays nothing (kill count,
  salvage and multiplier unchanged across an exit); a wave with a fled
  hostile still clears; the struck-facing field decays; a guard appears when
  the campaign is forced into the failing act and its label carries the
  surname.
- **`audiotest`:** the near-miss cue obeys the bank's contracts (never
  throws, respects the gesture gate, lands on the right bus).
- **`campaigntest`:** guard selection is deterministic per seed and
  doctrine-consistent.
- **`typecheck`** before every commit, as ever.

## 5. Out of scope, explicitly

- Tuning (skipped by ruling; `todo.md` §2 stands).
- Command-detonate torpedoes (deferred, wants its own spec).
- Any new input, weapon, hue, or time scale.
- Flanking for classes other than the swarmer; withdrawal for the Shroud.
- Guard appearances outside the failing act; anything resembling a boss.
