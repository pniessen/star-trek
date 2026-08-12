# The Environment — design

*Written 2026-08-11, approved in conversation before implementation. Nothing here
has been built. Filed flat in `docs/` alongside the other design documents
because `CLAUDE.md` enumerates this folder, and a spec a future session cannot
find is a spec that does not exist.*

Background: [encounters.md](encounters.md) §"Set decoration" holds the five
decisions the current sky was built on, three of which this document revises.
[comet.md](comet.md) is the most recent environmental feature and the source of
most of the technique here. [todo.md](todo.md) is what else is open.

---

## 0. The complaint

> "the planets, comets, and other non-ship related items just look like
> wallpaper, instead of flying through space"

and the target:

> "Ships and battle are great, but this is improving all the other enablers to be
> as rich (or richer) than the ships and battle. Imagine an effectively rendered
> 3-d jupiter slowly rotating in background, or a phosphorescent comet traversing
> your path"

A first pass at this document was rejected, correctly, as *"incrementally
better"*. That version was mostly plumbing — a starfield fix, a fog change, real
geometry instead of painted geometry — and while all of it is necessary, none of
it is what a person would point at. Its bodies were still wireframe spheres with
eight stripes. **This version leads with the things that actually produce
richness and treats the plumbing as what rides along underneath.**

---

## 1. Diagnosis, measured

Not opinion — this is what the code does today.

| Layer | Distance | Moves with the player? |
|---|---|---|
| Grid | underfoot | yes, `grid.follow()` |
| Starfield | 900-unit shell | **no — static at world origin** |
| `Backdrop` bodies (gas giants, suns) | camera-pinned | no, by design |
| `Planet` (ringed) | 520–1700, leashed | yes, real parallax |
| Comet | in-sector | yes, real parallax |

**The starfield is a defect, not a style.** `createStarfield()` builds a shell of
radius 900 centred on the *world origin* and nothing ever repositions it. A run
travels thousands of units at up to 62 u/s, so the ship leaves the shell. Parked
at 2,953 units from origin — which an ordinary run reaches — the stars bunch
visibly on one side of the frame and vanish from the other. Space stops
surrounding you.

**The middle distance is empty.** Fog is `45..260` (`Stage.ts:49`) and the far
plane is 2000. Between 260 units and the leashed planet there is nothing but
black.

**The bodies you mostly see cannot move.** `Backdrop` is pinned to the camera's
position and translated only by its rotation. That was decision 2 of five in
`encounters.md`, and it is the direct cause of "wallpaper".

**Fill rate, not geometry, is what this game costs.** `Stage.ts:44` renders at
`min(devicePixelRatio, 2)`, so a 1600×900 window shades 3200×1800 through a
~10-pass bloom mip chain plus phosphor, CRT and output encode — 85+ Mpix a frame,
identical whether the scene holds one body or twenty. Everything this document
adds lands on the cheap axis.

---

## 2. The organising principle

> **Things with a surface are real geometry in world space. Things that are light
> are painted on the sky.**

Real, parallaxing, rotating, occluding: gas giants, suns, moons, ringed planets,
asteroid clusters, hulks, gas shoals. Painted and camera-pinned: the star band,
nebula filaments, the galactic plane, the dust lane.

Every body whose shape you can read stops being a picture. That is the whole
change in one line.

---

## 3. The six levers

This section is the design. Everything in §5 exists to serve it.

### 3.1 One light source per sector, and every body obeys it

The single largest change per unit of work, and the first version of this document
barely mentioned it.

Give each sector a sun with a real world position, derived from the seed. Then
**terminate and limb-light every body from it** — planets, moons, asteroids, the
comet's head. Stroke brightness becomes a function of the angle between the
surface normal and the light, so the lit limb runs bright, the terminator falls
off, and the unlit side goes to near-nothing.

The result is not "better shaded spheres". It is that the scene stops being a
collection of independently glowing outlines and becomes **a place lit by a
star** — and flying around a body sweeps its terminator, which no amount of
surface detail can fake. `Backdrop` already computes a `terminator()`; that work
moves into world space where it can be seen.

### 3.2 Bloom is the atmosphere

The post chain's bloom keys off intensity above a threshold, and bodies are
currently drawn at uniform brightness — which wastes the most beautiful thing the
renderer has.

Draw a bright limb and a dim interior, with a halo of strokes densest at the
edge, and bloom turns it into atmospheric glow for free. This is the mechanism
behind the word *phosphorescent* in the brief; it is not a colour choice, it is a
brightness distribution.

### 3.3 Density, not outlines

Proven this week, in this repo, on the comet: 40 dashes read as scatter, ~500
connected filaments read as gas. Same medium, same palette, transformative
result. The lesson generalises and it is the cheapest richness available.

A gas giant needs **hundreds** of belt arcs with turbulence and shear, not eight
stripes. A moon needs a crater field, not a circle. The rule of thumb from the
comet: if it can be counted at a glance, there is not enough of it.

### 3.4 Real occlusion

Nothing in the sky occludes anything today, because a camera-pinned painting
cannot. A real body writes depth and **eats the starfield behind it**, and that
single cue does more for solidity than any surface detail. The machinery exists —
`Planet.ts` relies on it so its ring's far half passes behind the body.

### 3.5 Genuine scale

Current bodies are polite. One thing per sector should **dominate the frame** —
a third of the view, close enough that its limb curves out of shot. It costs a
number, and the scale contrast against a hull twenty pixels wide is most of what
sells "space".

### 3.6 Layered motion at different rates

Axial rotation on every body, moons genuinely orbiting their primary, ring shear,
dust streaming past the hull. Different depths moving at different rates *is*
depth perception. The sky already earned its `update(dt)`; this extends the same
permission to everything with a position.

---

## 4. Decisions taken

Recorded with what each closed off, so a later session does not silently reopen
them.

### 4.1 "Colour is information" now governs strokes, not bodies

**Owner's ruling.** Celestial bodies are exempt from the palette constraint and
may carry saturated hue and full luminance: a genuinely orange Jupiter, a red
sun. The rule continues to govern HUD strokes, beams, contacts and hulls.

This was chosen over two narrower options — bodies bright but desaturated, and
keeping the rule as written — with the risk understood: saturated warm colour now
exists in the world where Raider gold and Bastion red-orange already mean
something, so a glance during a fight could mislead.

**Three mitigations, and they are requirements rather than hopes:**

- **The scanner is the arbiter.** Bodies never appear as contacts, so anything
  ambiguous in the canopy is resolved by the tube. This leans on "the scanner is
  trustworthy", which is already locked.
- **Pulse and flash stay reserved for hostiles.** Bodies may be any colour but
  must not blink, throb or flare. Behaviour disambiguates where hue no longer
  does.
- **Small and distant is the dangerous case.** A frame-filling planet cannot be
  mistaken for a ship; a small moon at range can. Bodies below an apparent size
  threshold stay desaturated.

This supersedes the luminance half of `encounters.md`'s decoration rule, which
was written for a backdrop nothing flies through. It had already failed once in
practice: applied to the comet it made the plume invisible until the luminance was
raised. `CLAUDE.md` and `encounters.md` both need amending when this lands.

### 4.2 The far plane stays at 2000 and the leash stays

`Planet.ts` names raising the far plane with a logarithmic depth buffer as the
correct-but-not-taken option. It stays not taken. A 400-unit body at 1,700 units
reads about 27° across, which is enormous, so the far plane is not the binding
constraint on the *look* — the leash is the only lie, and it only bites if you fly
at it. Raising the far plane would touch every fat-line shader in the project and
risk depth artefacts across ships and HUD that already work.

### 4.3 Merged geometry, not many objects

Each `VectorObject` is a draw call with a fat-line shader. A dozen bodies is
nothing; forty individual asteroids is not. Clusters are built as one merged
geometry, the technique `hulls.ts` already uses to assemble a hull from
primitives. Free to do correctly and it is the difference between 12 draw calls
and 400.

### 4.4 No detail-tier toggle yet

`CLAUDE.md` is explicit that the control surface is full, and a binding spent on
graphics tiers before there is evidence anyone needs one is a binding spent on
nothing. **Measured counts go in `docs/todo.md` instead** — draw calls and
segments, the way the comet's "779 of 5000" is recorded — so the decision can be
made on numbers later.

The reason this matters: the owner's machine is about to become an M2 Max, which
*hides* performance problems. This game is deployed publicly, so anything tuned
until it feels good on that machine may be rough on a 2019 laptop. Implementation
verifies on the current machine, and the M2 Max is margin rather than budget.

### 4.5 Photoreal is not on the table

There are no textures and no samples — that is locked and correct. The target is
**stylised and gorgeous**: Elite's wireframe crossed with Geometry Wars' bloom.
The medium's strengths are glow, density and silhouette. Played to, that is
striking; fought against, it looks like a wireframe of something better. No task
in this design promises a photographic Jupiter.

---

## 5. Components

**`light.ts` — the sector's star.** A seeded world position, a colour, and the one
function every body's renderer calls to shade a stroke. Small, pure, and the
thing §3.1 hangs off.

**`bodies/` — real celestial geometry**, generalising `Planet.ts`. `SphereGeometry`
through `VectorObject` in the locked occluded idiom, plus per-kind stroke detail:
gas giant (dense belts, turbulence, storm oval, axial rotation), sun (bright limb
and flare, no surface — it *is* light), moon (crater field, terminator), ringed
(what `Planet.ts` does now, folded in). Each carries rotation, an anchor, a leash
and a light-facing shading pass. Fog-exempt, dimming by their own distance rule.

### 5.1 How a rotating body gets lit — the mechanism, and it is not obvious

Surfaced by reviewing this document rather than by writing code, and it decides
whether §3.1 through §3.3 are buildable at all.

`VectorObject` bakes vertex colours at construction. That is right for a hull,
whose stroke brightness never changes — but a body that rotates has a *moving*
lit side, so its brightness is a function of time. Baked colours cannot express
that, and neither the fat-line material nor the near-void face material takes a
light direction.

**So a body is two things drawn by two different mechanisms:**

- **The shell** is a `VectorObject` — a low-poly sphere in the locked occluded
  idiom. Its only jobs are to *write depth* so the body eats what is behind it
  (§3.4) and to give the silhouette. Uniform brightness is fine here because it is
  barely seen; the detail sits on top of it.
- **The surface detail** — belts, craters, the limb halo, ring strands — goes
  through **`TraceBuffer`**, regenerated every frame with per-stroke intensity
  computed from the light. This is exactly the mechanism `TraceBuffer` exists for
  and exactly what the comet's plume already does: 779 lit, moving segments a
  frame, rebuilt from scratch, at no measurable cost.

That split is the whole answer. Rotation becomes free — advance an angle and the
next frame's strokes land in new places with new brightnesses — and lighting
becomes a per-stroke multiply, which is the same shape as the plume's own falloff.

**The consequence is a budget problem, and it is the real constraint on §3.3.**
`TraceBuffer` holds 5000 segments for the entire game and the comet already spends
779. A hero gas giant with several hundred belt arcs, plus moons, plus shoals,
plus debris and beams in a firefight, will not fit. Two candidate answers, and the
choice belongs to implementation rather than here:

- **Raise `MAX_SEGMENTS`.** It is one number backing two `Float32Array`s; 20,000
  segments is 480 KB of vertex data, which is nothing. The reason to hesitate is
  that it is a shared ceiling and raising it hides overspend elsewhere.
- **Give the environment its own buffer.** A second `TraceBuffer` for scenery,
  so combat strokes and celestial strokes cannot starve each other, and each has a
  budget that means something on its own.

The second is probably right — a shared ceiling that combat and scenery compete
for is a ceiling where a busy firefight silently deletes the sky — but it wants
measurement, not assertion.

**`shoals` — gas you fly through.** Filament curtains at combat range, using the
comet plume's proven technique at a larger scale. They occlude and reveal
hostiles, bloom luminously, and are the strongest available answer to *being in*
space rather than looking at it.

**Starfield, fixed and split.** The shell recentres on the player every frame, as
`grid.follow` does, so stars always surround you — that closes the defect. A
recentred shell has no parallax by definition, so parallax comes from a separate
**near-field mote layer** in a wrapping box around the hull. Close things
parallax hardest; that is the motion cue.

**Fog and the grid, together.** Fog's far bound rises so the middle distance
exists. This is coupled: the grid spans `12 × 26 = 312` units and recentres on the
player, so fog at 260 is currently *hiding the grid's own edge*. Raising fog
without extending or separately fading the grid reveals a hard boundary in the
floor.

**`Backdrop` shrinks to far-field light.** It keeps the star band, nebula,
galactic plane and dust lane, and loses every `SkyBody`. Mostly a deletion. Its
recorded decisions are preserved as history rather than removed, the way
`altitude.ts` kept the plane's obituary.

---

## 6. Staging

Ordered by visual payoff per unit of work, not by dependency — the plumbing rides
underneath rather than leading.

1. **The hero body, as a throwaway-visible prototype.** One gas giant: real
   geometry, lit by a real sun, hundreds of belt arcs, bloom-driven limb, big
   enough to dominate the frame. Nothing else in this stage. **The owner looks at
   it before anything is planned around it.** If the medium cannot carry this, that
   is the cheapest possible moment to find out.
2. **The light source generalised** — terminator and limb on every existing body,
   including the comet's head and the ringed planet.
3. **Scale and occlusion confirmed** — bodies eating the starfield, one hero per
   sector.
4. **Gas shoals.**
5. **Starfield fix and near-field motes.**
6. **Fog and grid.**
7. **Mid-field furniture** — asteroid clusters, a drifting hulk, seeded per sector.
8. **Retire the painted bodies from `Backdrop`** — last, so there is never a frame
   with no sky.

---

## 7. Verification

The environment is judged by eye, so screenshots are evidence and assertions
guard against regression rather than prove beauty.

- **Assertions:** the starfield surrounds the player at 3,000 units from origin
  (the current defect, pinned); bodies are seeded — the same sector twice gives
  the same body; bodies rotate; a body occludes stars behind it; every body is lit
  from the sector's single light position; draw-call and segment counts stay under
  a recorded budget.
- **Screenshots:** each stage, at several distances, with the post chain **on** —
  bloom is load-bearing here, and a post-disabled shot cannot show whether §3.2
  worked.
- **Measured and recorded** in `docs/todo.md`: draw calls, segment count, and
  frame time on the machine of the day.

---

## 8. Risks

1. **The medium may not carry it.** §3 is a bet that density, light and bloom add
   up to richness in a stroke renderer. Stage 1 exists to test that bet for the
   price of one body.
2. **Colour ambiguity**, accepted by ruling in §4.1. The mitigations are
   requirements; if a small warm moon still reads as a Raider in play, the
   apparent-size threshold is the dial.
3. **The grid's edge**, revealed by the fog change. Known, coupled, and cheap if
   handled deliberately rather than discovered.
4. **Perf measured on the wrong machine** — see §4.4. The counts are the defence.
5. **`Backdrop` is a large, heavily-reasoned module** and this gutting is the
   biggest deletion the project has taken. Its decisions are history worth
   keeping even where its code is not.
6. **The stroke budget is the hard ceiling on §3.3's density**, per §5.1. Whether
   scenery gets its own `TraceBuffer` or the shared one is enlarged is the first
   technical decision stage 1 has to make, because "hundreds of belt arcs" is the
   whole bet and 5000 shared segments is what stands in its way.
