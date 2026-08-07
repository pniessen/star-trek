# Kobayashi — encounters and terrain

A candidate list, not a plan. Nothing here is committed and most of it never
will be; the point of writing it down is that the shortlist should be an
informed one, and that the reasoning behind a rejection is worth as much as the
idea.

Background is in [concept-options.md](concept-options.md) — Option D's encounter
system was explicitly kept "in the back pocket … as *what you find when you warp
into an empty sector*, which is exactly the content A will be short of." This is
that pocket, emptied out. [todo.md](todo.md) §5 lists it as deliberately not
built.

---

## The rule this list is built on

Every hostile in the game is defined by a **"punishes ___"** line — tunnel
vision, standing still, a weak facing, a habit, only reading the reticle. That
one sentence per class is why five ships feel like one design.

An encounter is not a sixth class in a funny hat. **An encounter asks a question
rather than correcting a mistake**, so every candidate below carries an
**"asks ___"** line instead. If a candidate cannot be given one, it is a hostile
and belongs in `HOSTILE_SPECS`, not here.

The precedent already exists: the Warden is the one thing in the sector that is
neither the player nor trying to kill them, and it works precisely because it
refuses to be scored.

### The two tests worth applying before anything gets built

**Does it attack a locked decision from the inside?** The strongest candidates
here are not the frightening ones. They are the ones that take a load-bearing
rule and hold it up to the light — the Dark against a trustworthy scanner, the
Hail against four shield facings, the Mimic against cyan-means-ours, the Split
against a multiplier that pays for kills. Those are the ones that would make the
game feel deeper rather than longer.

**Is it content, or is it a mechanic wearing content's clothes?** Most of this
list is content for a run. The Hunter is not — it is a campaign mechanic, and
the campaign is the half with a measured, unsolved problem
([todo.md](todo.md) §3.1).

---

## A. Clocks — the run acquires a deadline

**The Loom.** Two spinners that ignore the player entirely, orbiting a common
centre and laying a rising picket-fence wall of glowing filament around them.
Not a fight — a countdown. Leave through a gap, climb out over the top while the
wall is still low, or kill a spinner, which means crossing the enclosed space
and abandoning whatever cover you had. *Asks: can you tell when a fight has
become a countdown?* Nearly all `TraceBuffer` strokes; no new combat systems.
The wall **rising over time** rather than being open-topped or closed-topped is
what ties it to the altitude slab: height buys time, not immunity.

**The Assembly.** Something is being *built* out in the dark, out of parts the
hostiles drop, while you fight. It announces itself. Then it hunts. *Asks: will
you spend the run stopping a threat that does not exist yet?* The multiplier
makes ignoring it genuinely tempting, which is the whole design.

**The Bloom.** A spreading volume that drains the reserve while you are inside
it and grows all run. *Asks: how much of the sector are you willing to give up?*
One expanding sphere against the one energy pool.

---

## B. Indifferents — not fighting you, but changing the board

**The Maw.** Enormous, on a fixed course, eating mines, hostiles, and your
starbase. Invulnerable except down the throat, which is a torpedo run. *Asks:
will you fight something that was never fighting you?* Reaches the chart layer —
a sector can come out of a run permanently worse, and the strategy layer
currently has no source of that.

**The Shepherd.** An energy form that decides it likes you. Heals you, follows
you, and **will not let you leave the sector** — it collapses hyperwarp. *Asks:
what do you do about help you did not ask for?* Inverts the Warden exactly.

**The Nest.** A large, valuable, terrifying creature that attacks only when you
approach a cluster of small inert objects. Kill it and the sector's yield falls
for the rest of the campaign. *Asks: is the thing attacking you the aggressor?*
The encounter whose correct play is to leave.

---

## C. Inverters — a rule you have relied on stops working

**The Shoal.** Reflective shards. Phasers bounce; torpedoes do not. *Asks: can
you stop doing the thing that has worked for eight waves?* Your instant,
always-available, energy-cheap weapon becomes the thing hurting you.

**The Adapting.** After *n* phaser hits it is immune to phasers; then to
torpedoes. *Asks: can you ration a weapon you have never had to ration?* A small
change to `damage()`, an enormous change to a fight.

**The Mimic.** Reads on the scanner as the Warden. Cyan. Does not fire until you
are close. *Asks: what is your scanner actually telling you?* The most exciting
thing on this list and the most dangerous: it spends the credibility of the
colour language, which is a locked decision. That makes it a decision, not a
feature.

**The Swarm.** Many weak flyers, immune to weapons, killed only by proximity to
the starbase's floodlights or by your own hyperwarp flash. *Asks: can you fight
without shooting?*

---

## D. Bait — the greed loop, one level up

**The Derelict.** A dead hull worth a great deal of salvage, sitting exactly
where a Shroud would wait. *Asks: how much is your multiplier worth to you?*

**The Herd.** Drifting grazers, harmless, individually worth salvage. Shoot one
and the herd turns. *Asks: is restraint worth paying for?* This is concept D's
"the score rewards restraint" landing as a mechanic instead of as a scoring
rule, which is the only way it could survive in an arcade game.

**The Wager.** A large contact hails and offers terms: leave now and bank
double, or stay and it doubles the wave instead. *Asks: do you believe it?* It
should sometimes be bluffing.

---

## E. Judges — something evaluates you and responds

**The Probe.** Sweeps you, and behaves according to the *state* of your run —
full hull and it passes by; damaged and it decides you are flawed. *Asks: does
the game know how you have been playing?*

**The Gauntlet.** Everything else withdraws and one hostile matches you exactly:
your hull, your shields, your speed. *Asks: are you actually good, or have you
been out-statting them?*

---

## F. Vector-arcade ancestry — the sources this game descends from

**The Castle.** *(Star Castle, Cinematronics 1980.)* A rotating multi-ring
shield around a core, breachable only through a gap that keeps moving, and the
rings regenerate. *Asks: can you shoot a hole that will not hold still?* The
most direct ancestor on this entire list — a vector arcade game solving this
renderer's problem in 1980.

**The Redoubt.** *(Bosconian.)* A fixed installation with a vulnerable core that
**calls for help when you approach**, converting your own aggression into the
wave. *Asks: is this worth waking up?*

**The Well.** *(Gravitar.)* Gravity. Something pulls, and your thrust budget
stops being symmetric. *Asks: can you fly when the floor tilts?* Fighting a pull
costs reserve, which puts it straight into the one-pool economy.

---

## G. Space as the antagonist — no creature at all

**The Dark.** The scanner dies. Forward view only, until you dock. *Asks: how
much of your play was the scanner?* The most violent idea in this document,
because "the scanner is trustworthy" is a locked decision — and taking it away
for ninety seconds is how you find out whether it was load-bearing.

**The Trench.** A structure taller than the ceiling, bisecting the sector. You
cannot go over it. *Asks: what is the slab for when it cannot get you out?*
Turns altitude from an escape into a maze wall.

**The Fog.** Draw distance collapses, bloom climbs, contacts resolve late and
close. Nearly free — a post-chain change in a renderer that already has the
whole chain.

---

## H. Rule-benders — attacks on the game's own grammar

**The Echo.** A hostile with your exact hull, shields and speed, replaying *your
own inputs* on a delay. *Asks: do you know what you actually do?* Cheap — record
the input ring buffer and replay it — and unnervingly personal.

**The Split.** Killing it produces two smaller ones, which split again.
Asteroids' own rule applied to a ship. *Asks: do you know when to stop
shooting?* Directly at odds with a multiplier that pays you for killing.

**The Toll.** A gate offering instant travel anywhere on the chart, priced in
something that is not salvage — hull, or a fitted refit, or the multiplier
itself. *Asks: what will you trade that is not money?* One currency is locked;
this is how a second *cost* arrives without a second currency.

**The Quiet.** A contact that does nothing. Ever. In any run. *Asks: how long
before you shoot it anyway?*

---

## I. Non-combat

**The Hail.** Something that will *talk*. You answer with a weapon, with
silence, or **by dropping your shields**. In a game whose entire defensive skill
is four facings and turning a fresh quarter toward the threat, voluntarily going
to zero is mechanically terrifying — and it costs almost nothing to build.
*Asks: will you be vulnerable on purpose?* If one thing in this document ships,
it should probably be this one.

**The Convoy.** Slow civilians crossing the sector; hostiles prefer them to you.
Escort work that pays salvage, so it competes head-on with the greed loop.
*Asks: will you defend something that is not you?*

---

## J. Persistents — things that outlive the run

**The Hunter.** One named hostile that, if it escapes, survives on the chart as
a moving marker and returns next run stronger, having learned the range you like
to fight at. *Asks: are you willing to finish something?* The largest lever here
by a distance, and possibly an answer to the balance cliff — a hostile that gets
worse when you *do not* engage is a feedback term, which is exactly what
[todo.md](todo.md) §3.1 says the campaign is missing.

**The Debt.** Take salvage now from something that offers it, and it comes to
collect in a later run, in person.

---

## K. Terrain and backdrop — not creatures at all

A separate category, and the distinction inside it is the whole point.

**Backdrop** is what you cannot reach: a planet, a gas giant's limb, a distant
star, the glow of a nebula. It changes nothing mechanically and it is the
highest ratio of atmosphere to effort available to this project, because a
vector renderer draws a planet as one enormous circle and a horizon and it is
instantly the most impressive thing on screen. It is also the safest work in
this document — nothing can regress, because nothing depends on it.

Five decisions were taken before it was built, and they are the whole of it:

1. **Unreachable, always.** Nothing in the sky may enter the slab, be collided
   with, be shot, occlude a ship, or appear on the scanner. If the player can
   reach it, it is terrain and it was built wrong.
2. **The sky rotates with heading and does not translate with position.** Pinned
   to the camera's position, moved across by the camera's rotation. That one
   property is the entire illusion of distance in a renderer with no
   atmospheric perspective, and it matters more than anything being pretty.
3. **Each sector's sky is derived from `campaign.seed`, exactly as station names
   already are.** Same sector, same sky, every visit, across reloads. This is
   the actual point of the feature rather than a flourish on it: it makes a
   sector a *place*, and the empty low-yield sectors are the ones that most need
   to feel like somewhere rather than nowhere. It is also the cheapest partial
   answer available to §3.3 — a bare sector with nothing to bank at least stops
   being a bare sector with nothing at all.
4. **The colour rule is stricter here, not relaxed.** "Never introduce a
   decorative colour" and a backdrop is decorative by definition, so the sky may
   carry hue only at strictly lower saturation *and* lower luminance than any
   information colour, and never at information intensity. Cyan is forbidden
   outright — it means *ours*. A magenta gas giant that could be read as an
   unresolved contact is a bug wearing a look.
5. **Behind a flag, no new key.** The same shape as `flight.threeD`: off, the
   game is exactly what it was. The control surface is full and documented as
   full, so it gets a localhost debug hook instead of a binding.

The ring of a ringed planet is worth one note, because it looks like a new
problem and is not: draw the far half of the ring, then the planet as an
occluding near-void disc with a glowing rim, then the near half in front. That
is the overlapping-ships case the occluded-geometry decision already solved.
A locked decision paying for itself a second time is the sign it was the right
one.

**Terrain** is what is in the play space, between 0 and 78 units, and it has to
justify itself against the flight model.

- **Asteroids.** Structurally the minefield with different rules: a persistent
  field of things on the floor, which is a system that already exists. They do
  not chase, they can be shot, and — this is the argument — **they occlude.**
  "Occluded geometry, not pure wireframe" is a locked decision, and right now
  nothing in the sector actually hides anything. Cover only means something if
  there is something to hide behind. Asteroids are the cheapest way to make an
  already-locked rendering decision pay for itself, and they give the slab a
  second job: flying *over* a field instead of through it.
- **A dust cloud or nebula.** The Fog, above. A post-chain change, and the one
  piece of terrain that costs almost no geometry.
- **A black hole.** The Well, above, plus one interesting collision with a
  convention: `y = 0` is a floor that nothing ever goes below. A hole *in* the
  floor is the first thing that would ever want to. That is either a lovely
  exception or a rule violation, and it should be decided deliberately rather
  than discovered.
- **Planets, up close.** Do not. Engagement happens between 14 and 78 units; a
  planet at that scale is a wall, not a world. Planets belong in the backdrop
  category and nowhere else.

---

## On names and marks

The locked decision is "our own universe — the genre is not protectable; the
marks are." The owner has said he is willing to relax it.

The position this document takes, until told otherwise: **borrow freely in the
docs and in conversation, keep shipped strings ours.** It costs nothing and
keeps both doors open, and any individual encounter can be named after its
source later if that turns out to be worth it. The cost of the other order is
real and lands late — names thread through `hulls.ts`, the HUD, the deck log,
the audio cue names and `chart/naming.ts`, so "we will swap them later" is a
refactor across six directories.

The exposure is also asymmetric by candidate. Where a design's identity is
*diffuse* — spread across proportion and detail — borrowing the archetype is
close to free. Where a design's identity **is** a single unmistakable feature,
the most legible thing and the most identifying thing are the same thing, and
that is the case to think about rather than the case to assume is fine.
