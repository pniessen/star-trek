# Kobayashi — status and roadmap

Written August 2026, after three working sessions. Covers what exists, why each
decision was made the way it was, what is deliberately not built, and what comes
next.

---

## 1. Where this came from

The brief was a Star Trek–style game with first-person battle, a navigation and
strategy layer, and a futuristic vectorized feel. The first session surveyed
fifty-five years of prior art — see [prior-art.md](./prior-art.md) — and found
that the genre has been solved in pieces, repeatedly, by people working under
severe constraints, and the pieces have never been assembled with modern
rendering:

- **Star Trek (1971, BASIC)** contributed the strategy skeleton — an 8×8 grid, a
  stardate deadline, energy as scarce currency, phasers that weaken with range.
- **Star Raiders (1979)** is the closest ancestor: first-person cockpit combat
  welded to a live galactic chart, with enemy fleets advancing while you fight.
  No modern version of it exists.
- **Sega's Strategic Operations Simulator (1982)** contributed the split display:
  a forward view for shooting and an overhead scanner for knowing where you are.
- **Battlezone, Tempest, Star Wars (1980–83)** and Tempest 4000 (2018) set the
  visual bar and established that the look is a post-processing recipe, not a
  modelling one.
- **Starfleet Command and Bridge Commander (1999–2002)** contributed the combat
  verbs: energy allocation and per-facing shields.
- **FTL, Duskers, NEBULOUS** contributed diegetic instruments — everything the
  player reads is something the ship is drawing.

Four concepts came out of that ([concept-options.md](./concept-options.md)).
The chosen path was **B → A**: build *Kobayashi*, the pure vector arcade run,
then grow it into *Deep Black*, the strategic layer, because B is A's cockpit
with the chart removed and shares a renderer, a flight model and a combat model.

---

## 2. Decisions that are locked

These are settled and everything else is built on them. Recorded here because
the reasoning matters more than the conclusions.

| Decision | Why |
|---|---|
| **The play space is a plane** | The overhead scanner is only trustworthy if the world is flat. In 3D the map has to lie about altitude and the player learns to distrust it. Planar means every contact is exactly where the scanner says, and the skill becomes rotational. |
| **Occluded geometry, not pure wireframe** | Pure wireframe is authentic and unreadable the moment two ships overlap — you cannot tell which is in front. Same glowing strokes over near-void opaque faces gives unambiguous depth and loses nothing of the look. |
| **One energy pool** | Thrust, shields and weapons all draw from one reserve. Every burn is a shot you cannot take later; that tension is the combat design. |
| **Four separate shield facings** | Turning a fresh quarter toward whatever is shooting is the defensive skill. Without it this is *Asteroids* with glow. |
| **Phasers vs torpedoes** | Instant, energy-draining, weaker with distance versus limited, slow, must-be-led. Opposite characters make "which do I use" a question rather than a preference. |
| **No win state within a run** | The Kobayashi Maru is the unwinnable test. Runs escalate until you die; the *campaign* is what can be won. This is what lets an arcade game carry an empire layer. |
| **The multiplier is the currency** | It climbs while you stay undocked and untouched, halves when something reaches the hull, and is only realised as score when you dock. The arcade question and the strategic question are then the same question. |
| **Vector, with a hybrid** | Not a literal 1982 XY monitor. Glowing stroked edges, opaque black faces, depth-faded lines — nostalgic in recipe, current in execution. |
| **Web, no engine** | TypeScript, Vite, Three.js, WebGL2. Instant playability, shareable by link, and this look is cheap in WebGL because it is lines and post-processing rather than models and lightmaps. |
| **Our own universe** | The genre is not protectable; the marks are. No LCARS, no delta, no familiar species. |

---

## 3. What is built

~3,200 lines of TypeScript across three commits.

### Rendering

The look is entirely in the pass order:

```
scene → bloom → phosphor persistence → CRT glass → output encode → screen
```

- **`VectorObject`** builds one solid and draws it two ways — pure wireframe, or
  identical edges over near-void opaque faces. `G` toggles live, so the
  comparison is honest rather than two builds.
- **`PhosphorPass`** is a feedback buffer with per-channel decay, so the
  blue-green trace outlives the red. Decay is per *second*, not per frame.
- **`CrtPass`** is barrel distortion, scanlines, vignette and corner
  convergence error — deliberately under-driven and fully toggleable, because
  this is the effect most likely to tip the look into "emulator screenshot".
- **`TraceBuffer`** is one preallocated world-space stroke buffer that beams,
  torpedo streaks and explosion debris all share.
- Hulls are low-segment primitives merged into solids, so crease edges read as
  facets. The player's cruiser is about 40 strokes.
- **The HUD contains no DOM text.** Every glyph is drawn from a hand-authored
  stroke font through the same bloom as the ships, in a fixed design space that
  scales to the window.

### Combat

- Five hostiles, each punishing one habit and each with its own silhouette and
  hue: **Raider** (gold, a stooping raptor) punishes tunnel vision, **Lance**
  (acid green, a horseshoe open at the bow) punishes standing still, **Bastion**
  (red-orange, a command bulb between swept engine wings) punishes a neglected
  shield facing. They hold a preferred range, strafe rather than driving straight
  in, lead their shots, and cannot fire when out-turned. The archetypes are the
  genre's shared visual grammar; the hulls are our own geometry.
- The last two do not duel at all, which is the point of them. **Harrow**
  (violet, a flat-decked tender with the ordnance visibly on its rails) never
  fires: it leads mines onto the course you are already flying, and they persist
  across waves until they burn out, so the sector you have been circling becomes
  the sector you can no longer circle. Mines are shootable, chain-detonate, and
  cost you the shots you would rather have spent on something shooting back.
  **Shroud** (magenta, a blade) is invisible and unhittable until it commits;
  it materialises over 0.45s, empties a burst, and fades. Killing one means
  being pointed at it before it arrives, which is a scanner problem.
- Hits route to the quarter facing the shooter; only the remainder reaches the
  hull.
- **Ships explode into the line segments that drew them** — the hull's own edge
  list, pushed outward and tumbled. No particles, no sprites.
- Waves escalate and ring the player rather than clustering ahead.
- **Docking is a sequence**, not a proximity check: a marked corridor with rails
  and travelling chevrons, a gate you fly through, a tractor that takes the helm
  and pulls you in, systems restored one at a time, an itemised tally with the
  score odometer rolling, and a deliberate departure under thrust. An approach
  instrument shows lateral offset and speed so lining up is something you do.
  Waves keep coming while you are moored — you can turn and shoot, but not move.

### Feel

- **Hit-stop** on torpedo impact, on kills, on a hull breach and on death. It is
  an explicitly bounded multiplier on game seconds, never a freeze, refreshed
  rather than accumulated, and drained on wall-clock seconds so dilation can
  never slow its own recovery — see the last entry in §4 for why that was worth
  spelling out in a class comment rather than a constant.
- **Dying is a sequence too.** The hull comes apart into its own edge segments,
  through the same debris field every hostile goes through; a shock ring runs
  out across the plane; hit-stop holds the moment; the camera lets go of the
  ship, holds low and close, then rises and pulls back into a tilted orbit of
  the wreck; the instruments brown out as one failing supply rather than
  blinking off; and the run is added up on emergency power, with what it was
  worth one dock short of home as the number that lands hardest.

### The arcade shell

A title screen, a demonstration, and the game. The title is one of the ship's
own instruments — brackets, a rule, dim labels against bright values, the same
stroke font as every other readout, over a slow orbit of the cruiser. Attract
mode is not a canned animation: it is the real session with a demo pilot on the
stick, so everything the demo shows is something the game genuinely does,
including flying the docking corridor home once the pot is worth banking. Any
key that is not a display toggle takes the controls, and an abandoned death
tally falls back to attracting the way a cabinet does.

This is a shell *around* the session rather than a state inside it:
`Session.state` is still only `clear`/`fighting`/`dead`, because a title screen
is not a phase of combat and pretending it was would put a fourth case into
every rule that reads the run. The shell is `__probe.mode`.

### The scanner

Heading-up, contacts glyphed by class, off-range contacts pinned to the rim.
This is the reason the play space is planar, so it is not optional dressing —
it is half the interface, exactly as it was on the 1982 cabinet.

It is now an instrument rather than a readout, in two tiers. Anything with a
hull you could shoot is still drawn at its true position — a planar world is
supposed to make this tube trustworthy and a scanner that misplaces a Bastion
breaks that for nothing. What degrades is *confidence*: a contact dims between
sweeps and flares as the arm repaints it. A cloaked hull gets the other tier —
it exists only when the arm crosses it, is placed with a real positional error,
and decays away over three seconds. The error is drawn as the circle it actually
is and the offset is always smaller than the circle, so the true contact is
genuinely somewhere inside the mark. Three returns in a row with each ring
tighter than the last is a Shroud closing, and reading that before it
materialises is the whole skill of the class. No false returns: ambiguity from
staleness and error teaches you something, a phantom would only teach you to
distrust the one instrument the game has promised is honest.

### Verification

`tools/playtest.mjs` drives a whole run headlessly and asserts eleven rules —
waves spawn, phasers draw energy, kills bank salvage, the multiplier climbs,
torpedoes deplete, explosions produce debris, docking banks and resupplies and
resets, hull loss ends the run, restart is clean.

**The harness now has to launch its own run.** A fresh load lands on the title
screen and nothing spawns behind it, so the first assertion needs a keypress —
`await page.keyboard.press("Enter")` after `goto`, or
`window.__presentation.startRun()` — before waiting on wave one. Without it the
page sits on the title for thirteen seconds and then starts a demonstration
that fights the harness for the keyboard.

---

## 4. Bugs found, and what they teach

Worth recording because each one was invisible until something forced it into
the open.

**No output colour-space encode.** The composer was writing linear light
straight to an sRGB display. Bright bloomed strokes looked fine because they
clip white anyway, but everything dim was crushed to black — the starfield and
grid appeared to be missing entirely. The HUD looked correct throughout because
it renders direct to the canvas and *was* encoded, which is what gave it away.
This would have quietly poisoned every colour judgement made afterwards.

**Phosphor decay was per-frame, not per-second.** The trail lengthened on slower
machines. The feedback buffer also held unclamped HDR values, so a bright stroke
sat above the clipping point for ~40 frames and then vanished all at once — it
read as burn-in, not as a trail.

**Tapped keys were dropped.** A key pressed and released between two frames was
never observed as held. At 60fps that is a 16ms window a fast player will find,
and the shot simply never happened. Presses are now latched and consumed by the
next frame.

**The HUD was laid out in raw pixels**, so instruments collided at small window
sizes. It now draws in a fixed design space.

**A sustained turn held ~50° of roll**, tipping the horizon over. Bank is now a
transient lean.

**The wave clock stopped while docked.** Any dock state short-circuited wave
spawning, so the station was somewhere to hide and lingering cost nothing —
exactly backwards for a loop about whether to bank or push on. Combat phase and
dock phase are now tracked separately, because they are genuinely independent.

**Departure shoved you back into the clamps.** Thrust is how you ask to leave,
and thrust points at the station. There is now a short window after release
where forward thrust is ignored.

**One non-bug worth knowing about:** roughly an hour went into what looked like
a 100× performance regression. It is an artifact of headless SwiftShader, which
needs about half a second per frame for ~15 full-screen post passes at
1280×800; the loop's `dt` clamp then puts game logic into slow motion, which is
why waves appeared not to spawn at all. Confirmed by A/B against the previous
commit. Real GPUs run the same chain in under 2ms, but it will bite anyone who
puts this in CI.

---

## 5. The strategy layer, designed but not built

[strategy-layer.md](./strategy-layer.md) has the detail. In summary: an 8×8
chart between runs where salvage buys structures (with build times measured in
runs, not rushable with money), refits that are all genuine tradeoffs, and
patrols that buy turns rather than safety. The enemy spends pressure points
after every run, so ignore a sector for four runs and it falls — and stays
fallen.

The rule that keeps it an arcade game: **Into the Breach, not Stellaris.** Four
decisions per chart visit, no submenus, one currency. If the chart visit ever
takes longer than the run, the layer has failed and we cut it back.

---

## 6. What is deliberately not built

- **Audio.** Nothing yet. Planned as WebAudio synthesis rather than samples.
- **Mouse aim.** Aiming is currently the nose, which is the Sega model and
  correct for a planar game. Mouse aim is worth testing but may make it too easy.
- **Leaderboards and persistence.** `localStorage` and a seeded RNG when it
  arrives; no backend, no accounts. The title screen shows a best-of-this-
  sitting and says so, rather than implying a record it does not keep.
- **Mobile and touch.**

---

## 7. Roadmap

**Now — audio.** Nothing makes a sound yet, which is why the docking sequence
still feels slightly thin despite the visuals. Synthesised WebAudio rather than
samples: a rising tone under tractor capture, a clunk on hard dock, ascending
blips per service stage, an arpeggio on the tally that pitches with the
multiplier, plus weapons and an alert drone tracking threat.

**Then — tuning.** The flight model and wave pacing are first-draft numbers and
want a human on the keyboard. Specifically: turn rate and drag, phaser falloff
curve, how fast the multiplier climbs, and whether the wave break is too long.
This is the one item on the list that cannot be done by reasoning about it.

**Next — game feel.** Hit-stop, the death sequence and the attract mode are
built; audio is the piece still missing, and every one of the new constants is a
first-draft guess. Feel is most of what an arcade game is, and it is cheap to
iterate now the renderer exists.

**Weeks 6–8 — the chart, in-run.** An 8×8 sector map, hyperwarp between sectors,
fleets that advance on a clock while you fight. This is the step that turns
Kobayashi into Deep Black, and it doubles as the empire screen's renderer.

**Weeks 9–12 — the campaign.** Build, refit, deploy, choose the front. Enemy
pressure. Win and loss conditions for the war.

**Later.** Territorial control *during* a run, if the between-runs version earns
it. The exploration encounters from concept D, seeded into empty sectors.

### Open questions

- Does the campaign need to be shorter? An 8×8 chart at ~3 pressure per run
  implies 30–50 runs; a 6×6 opening chart is worth testing.
- Do refits persist through death, or are they lost? Leaning persist.
- Is mouse aim an improvement or does it remove the reason to turn the ship?

---

## 8. Repository

Everything lives on the branch `claude/star-trek-game-research-vyae7o` in
`pniessen/star-trek`, fully pushed. `main` still holds only the initial commit —
nothing has been merged, and no pull request has been opened.

| Commit | Contents |
|---|---|
| `54faabc` | Prior-art research, four concept options, visual dossier |
| `11eb866` | Vector renderer, wireframe/occluded toggle, post chain, stroke HUD |
| `45b824e` | Combat, hostiles, waves, docking, the multiplier, the scanner, strategy-layer design |

```
npm install
npm run dev                  # http://127.0.0.1:5173
npm run typecheck
node tools/playtest.mjs      # headless run + assertions + screenshots
```
