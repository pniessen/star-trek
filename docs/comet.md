# The Comet — design

*Written 2026-08-10, approved before implementation. Nothing here has been
built. Filed flat in `docs/` alongside the other design documents rather than in
a tool's own directory, because `CLAUDE.md` enumerates this folder and a spec a
future session cannot find is a spec that does not exist.*

Background: [encounters.md](encounters.md) sets the bar every candidate here has
to clear, and this one is measured against it in §1. [status.md](status.md) is
how the rest got built; [todo.md](todo.md) is what else is open.

---

## 0. Where it came from

*Balance of Terror* (TOS, 1966). The Enterprise cannot see a cloaked ship, so
Kirk times his attack to the moment it crosses the tail of comet Icarus IV —
ionization outlines a hull that sensors cannot find. The comet is not scenery in
that episode. It is the only reason the engagement is winnable.

This game already owns both halves of that scene. The **Shroud** is a cloaker
whose entire identity is *never resolves*, and `PALETTE` gives it magenta for
exactly that reason. What has been missing is the comet: **nowhere on the board
is currently worth fighting in.** The minefield is somewhere to avoid, the
starbase is somewhere to go, the gate is somewhere to leave through. No square
of space has ever been worth choosing.

---

## 1. Against the two tests

`encounters.md` sets two, and this is the honest scoring.

**Does it attack a locked decision from the inside?** Yes — *the scanner is
trustworthy*, which the document itself calls the most violent thing you could
take away. See §3 for why this bends it without breaking it.

**Is it content, or a mechanic wearing content's clothes?** A mechanic. It
changes what your instruments do in a region, and everything visible about it is
a consequence of that rule rather than a decoration on top of it.

**Asks: how much of your play was the scanner — and is a place worth more than a
position?** The first half is inherited from *The Dark*, bounded in space and
time instead of run-wide. The second is new here and is the reason to build it:
the whole tactical layer to date is about *where you are pointed*, never about
*where you are standing*.

---

## 2. The rule

One sentence, and every effect below is a consequence of it rather than an item
on a list:

> **Inside the tail, no instrument works.**

Three consequences:

1. **Cloaks fail.** A cloaking device is an instrument. A Shroud inside the tail
   winds down and cannot re-veil while it is there.
2. **Nothing locks across the boundary.** If either party is inside, long-range
   fire control fails; hostiles must close to visual range to shoot. This is the
   half that hides *you*.
3. **The scanner stops resolving.** Contacts degrade into the unresolved return
   the game already draws — broken ring, no altitude stalk.

The inversion is the point, and it is what makes the encounter memorable rather
than merely difficult:

| | Outside the tail | Inside the tail |
|---|---|---|
| The scanner | truth | vague |
| Your eyes | limited | truth |
| A Shroud | invisible | drawn, and huntable |

**One rule, not three effects.** If these were listed as three features they
could be tuned apart from each other and would drift into incoherence. They are
written down as consequences so that a later change to one has to be argued
against the sentence at the top.

---

## 3. The locked decision, and why it survives

`CLAUDE.md`: *"the scanner is trustworthy"*. That is load-bearing and this
design comes closer to it than anything built so far, so the argument is
recorded rather than assumed.

**Trustworthy is not the same as omniscient.** The scanner never shows anything
false here. It shows *less*, and it says so, in a vocabulary the game already
owns. `hud/scanner.ts` is explicit in its own header — an unresolved return is a
broken ring carrying no height, *"because a scanner that could not resolve the
contact could not have resolved its height either. The stalk is honest by being
absent."*

The Shroud has always proven that the scanner is permitted not to know. The tail
extends that permission from one hostile class to a region of space. Nothing is
ever drawn where it is not.

**The line that must not be crossed:** no phantom contacts, no displaced
contacts beyond the existing ghost spread which is honest by construction — the
drawn circle always contains the truth — and no silent degradation. The tube has
to *look* interfered with, or a player reads a quiet scanner as an empty sector
and the rule becomes a lie by omission.

---

## 4. Two schedules, one object

The owner asked for both a sector fixture and a wanderer. They share the class,
the tail volume, the rule and the renderer; they differ only in placement,
scale, and whether they leave. Anything else would be the same feature built
twice.

| | **Fixture** | **Wanderer** |
|---|---|---|
| Placement | Seeded per sector from `campaign.seed`, exactly as `Planet.ts` places the ringed giant | Rare roll at a wave break, as `Loom` arrives |
| Frequency | ~1 sector in 4 | Rare, and never in a sector that already has a fixture |
| Scale | Large nucleus, long tail | Smaller, denser, shorter |
| Motion | Drifts slowly across the run, so the tail sweeps | Crosses and leaves within a couple of minutes |
| Character | Terrain you plan around | A window that opens and shuts |

**The fixture is the one that earns its keep strategically.** A sector with a
comet is a sector you would *choose* to intercept in, which is the first time the
chart has had a reason to care what a square contains beyond threat and yield.
That is a genuine link between the two halves of the game and it is the strongest
argument for building this at all.

**The wanderer is the one at risk of being redundant** — the Loom already
occupies "rare thing that arrives at a wave break". It is differentiated by being
an *opportunity* rather than a clock: the Loom is something you survive, the
wanderer is something you exploit or miss. If flying it shows the two reading as
the same event, the wanderer is the half to cut.

---

## 5. The ion drain

Without a cost the tail is a safe room. Hostiles cannot lock you, so "you cannot
see them coming" is not a real price if they cannot shoot you either.

**A light drain on the reserve, per second, while inside.** Priced well under
`ALTITUDE.drain`, because altitude is a burst and this is a place you might hold
for a whole engagement.

Two reasons it is the drain rather than the alternative:

- **It uses the locked one-pool economy** rather than adding a fifth thing to
  reason about. Thrust, height, phasers and regen already arbitrate through
  `energy`; the tail joins that argument instead of starting a new one.
- **It converts the tail from a place into a resource.** You spend time in it,
  and time in it is shots you will not fire later. That is the same shape as
  every other decision in the game.

The rejected alternative — *hostiles converge to visual range, so camping means
being surrounded with no scanner* — is more elegant and is not being built,
because it depends on hostile approach behaviour doing something it does not do
today. It is a change to five classes' AI to avoid one constant. Recorded here
so a later session does not think it was overlooked.

**This is not the same thing as §2's second consequence, and the two are easy to
confuse.** Denying a hostile its shot beyond visual range is fire-control
suppression: one gate on whether it may fire, and it is cheap. Making a hostile
*fly* toward you because it has lost contact is navigation, and every class has
its own approach behaviour and preferred range. The rule in §2 is the first. The
rejected brake was the second.

---

## 6. Rendering

Everything obeys the locked idiom.

- **Nucleus** — real occluded geometry through `VectorObject`, small and
  irregular. It is a solid object and should occlude the tail behind it, which is
  the same argument `Planet.ts` records for why the ringed planet stopped being a
  picture.
- **Coma** — a halo of short strokes around the nucleus.
- **Tail** — streaming strokes through `TraceBuffer`, regenerated each frame,
  drifting along the tail axis and brightening toward the nucleus. `CLAUDE.md`:
  transient strokes go through `TraceBuffer`, not new objects and materials.
- **Direction** — away from the sector's sun. `Backdrop`'s bodies carry an
  `azimuth` that is a true world bearing (`atan2(x, z)`, azimuth 0 is dead ahead
  at heading 0), so when the sky has a sun the tail can point away from *that*
  sun rather than from an invented one. Sectors whose sky has no sun fall back to
  a seeded bearing.

**Colour.** *Colour is information* is locked, and the comet may not take an
information hue. It gets a pale, heavily desaturated ice-blue, under the rule
`encounters.md` already set for the sky: decoration may carry hue only at
strictly lower saturation *and* lower luminance than any information colour.

The tempting mistake is to draw the tail magenta because magenta means
unresolved and the tail is what unresolves things. It is rejected: magenta is
also the Shroud's own colour, and a magenta field is the worst possible
background to hunt a magenta contact against.

**On the scanner** the tail draws as a faint wedge. It has to, or the fixture
cannot be navigated to — and a region you cannot find is a region that does not
exist. The wedge is geometry, not a contact, so drawing it is honest even while
contacts inside it are degraded.

---

## 7. Implementation shape

### The one non-obvious change

`hud/scanner.ts` already scales its ghost error by `hostile.cloak`, so *how
unresolvable is this contact* is already a single number with a single drawing
path. Tail interference wants that same path.

It must **not** reuse `cloak` itself. That field also gates visibility and
hittability — `hidden()` is `cloak > HIDDEN_AT`, and `shape.group.visible` reads
it — so raising it for interference would make hostiles invisible and
invulnerable inside the tail, which is the opposite of the intent.

So: a second field, **`interference`**, scanner-only, and `paintGhost` keys off
`max(cloak, interference)`. Two causes, one grammar, no new HUD vocabulary.

The pleasing consequence: inside the tail the Shroud's `cloak` is being driven
*down* while everyone's `interference` is driven *up*, so all contacts converge
on the same partial return. Everything looks alike on the tube and you are forced
to the canopy. That is the design's own thesis falling out of the data model
rather than being staged.

### Files

- **`src/game/comet.ts`** — new. `COMET` constants, the object, the tail-volume
  test, and both schedulers. Mirrors `loom.ts` and `mines.ts`. Behind
  `encounters.comet`, defaulting on, beside `encounters.loom`.
- **`src/game/hostiles.ts`** — the new `interference` field; cloak suppression
  inside the tail; lock suppression across the boundary.
- **`src/hud/scanner.ts`** — `paintGhost` keyed off both sources; the tail wedge.
- **`src/game/session.ts`** — update seam, the drain, and the queries.
- **`src/main.ts`** — `window.__comet.seed()` on localhost. **No key binding**,
  for the reason `loom.ts` records: the control surface is full and a binding
  spent on something rare is a binding spent on nothing.

### Testing

`tools/playtest.mjs`, in the house style — assert the rule, not the constants:

- a Shroud inside the tail loses its cloak and cannot re-veil
- a hostile outside cannot lock a player inside
- contacts inside degrade to unresolved returns, and the tube says so
- the reserve falls while inside and stops falling on exit
- the fixture is seeded — the same sector gives the same comet twice
- the tail points away from the sun when the sector's sky has one

---

## 8. Known risks

1. **The tail may be strictly better than the open sector.** The drain is the
   brake and it is a first-draft guess like every other constant here. If it is
   too cheap, the answer to every wave becomes "go to the comet", and the
   encounter has eaten the game rather than enriched it.
2. **The wanderer may read as a second Loom.** See §4. It is the half to cut.
3. **Hunting by eye may simply not be fun** with no pitch input and a 31°
   half-FOV. This is the assumption the whole design rests on and it cannot be
   settled from the source. It is the first thing to fly.
4. **Draw cost.** The tail is a per-frame stroke field on top of a post chain
   that already costs half a second a frame under software GL. The playtest
   harness runs at 640×400 with post disabled for exactly this reason, and the
   tail budget has to be set against a real machine.
