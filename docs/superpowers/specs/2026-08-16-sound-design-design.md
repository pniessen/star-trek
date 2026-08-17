# The Sound of the Place — design

*Written 2026-08-16, approved in conversation before implementation. Sub-project
one of two: the sound-design overhaul (bench, ship, world, radio). The
generative music layer is sub-project two and gets its own spec after this
lands, because it depends on the bench and buses this one builds.*

Background: [audio-prior-art.md](../../audio-prior-art.md) is the research this
was built against — its §6 palette was written after the audio layer and never
built; its governing finding (CHI 2024, n=1,699) is that **differentiated**
feedback drives enjoyment while merely louder feedback measurably hurts
perceived competence. [todo.md](../../todo.md) §4 lists the three places the
built layer contradicts that research. `src/audio/Synth.ts`'s header is the
contract every cue obeys and this spec keeps: two rules — nothing may throw,
nothing before a gesture — and one bench everything comes off.

---

## 0. The owner's rulings

1. **Full soundscape**, decomposed into two specs: this one (everything but
   music), then the generative music layer.
2. **FM joins the bench** as a third voice kind. Still one bench.
3. **The music layer, when it comes, is both** an event-driven sequencer and
   an ambient wash. Out of scope here; §7 reserves what it needs.
4. **The two distinctive ideas are the radio and the acoustics** — chosen from
   a slate of seven over the checklist. The radio is a *tell* and gives HQ and
   the Warden real voices too. The acoustics are per-sector *and* positional.

Everything else in this document is the plumbing those two ideas stand on,
plus the parts of the research palette that make the ship legible.

---

## 1. Two ideas that make the sound singular

### 1.1 The radio — the war has a voice you can hear

The war already has words: HQ dispatches, the commander's name, the Warden's
hails, the deck log. They are text. This gives the ship a **comms channel**:
one bus on which three parties speak, in an idiom that is unmistakably speech
and contains no words.

**The idiom.** A *vocoder-shaped* synth phrase: a buzzy carrier (pulse or
sawtooth) through **two to three swept formant bandpass filters**, gated into
syllable-length bursts with pitch contour — the R2-D2 / radio-squelch family.
It reads as "someone talking" without ever being language, which is what
keeps it own-universe and sample-free. Every phrase opens and closes on a
squelch: a short noise burst through a resonant highpass, the sound of a
carrier keying. Band-limited hard (300–3400 Hz — the actual telephone band,
which is why it reads as radio) so it never fights the alert or the phasers.

**Three voices, one channel, distinct by construction:**

- **Ours (HQ).** Level, mid pitch, measured cadence — the calm end.
  Speaks *before* the dispatch text lands (a syllable or two of preamble, then
  the line appears), so the text arrives as a transcript of something heard.
- **The Warden.** Slightly higher, warmer, brief — hails and its
  "SECTOR CLEAR"/farewell lines get a short phrase each. Cyan is ours; the
  Warden shares the "ours" contour, offset in pitch — the ally sounds like us,
  which is the same choice its colour made.
- **Theirs.** Distorted harder (more carrier drive, narrower band), and
  **cadenced by doctrine** — the one hook into the war's mind:
  Raider: clipped, fast, many short bursts. Hammer: slow, low, monotone
  bursts. Anvil: sparse, even, long syllables. The commander's own guard adds
  a small pitch signature. Nobody can understand them; anyone can learn them.

**Chatter is a tell.** Enemy phrases fire on real events, so an attentive ear
hears the shape of the fight before the scanner shows it:

| event | who | what a player learns |
|---|---|---|
| a wave forms up (spawn) | theirs | how many voices ≈ how many hulls; doctrine cadence = which commander |
| a Lance begins its charge | theirs (short, rising) | a shot is being lined up — the doc's "tell" for the sniper |
| a Shroud commits (reveal wind starts) | theirs (one squelch, no phrase) | *something* keyed a carrier — the only warning a cloaked knife gives |
| a hostile withdraws | theirs (falling, breaking up) | it is leaving; chase or let go |
| swarmers begin flanking (the stern gate opens) | theirs (overlapping bursts) | the flank is coordinating |
| HQ dispatch | ours | the line is coming — preamble then text |
| Warden arrival / hail / lost | Warden | company; a friend gone |

Never orders, never text-dependent: the phrases carry no content the board does
not already hold, so a deaf player loses nothing they could not read. The
information is *earlier*, not *more*. Rate-limited per speaker (one phrase in
flight per party; a new event replaces rather than queues) — a wave of six
Raiders is a chattering channel, not six overlapping voices.

**Attract firewall:** the demo campaign speaks too — that is the demonstration
— but nothing the radio does writes to any campaign, ever.

### 1.2 The acoustics — sectors have a body

Every sector already looks like a place. This makes it sound like one. **The
mix runs through a per-sector space**, and the space is derived from what is
actually there — the same seed-derived facts the eye already sees.

**The space, per sector.** One synthesised impulse response — no samples; a
short procedural IR built at sector entry from decaying filtered noise plus
discrete early reflections — into a `ConvolverNode` on a send bus. Its shape
comes from `planHero` and the shoal/comet plans:

| what's there | the room |
|---|---|
| `rocks` hero | slap echoes: 3–6 discrete early reflections at 40–180 ms, bright, decaying fast; a torpedo detonation *comes back off the field* |
| gas shoal present | muffled: the send is lowpassed and lengthened; the tail is soft and dark |
| `giant` | a long dark tail (~2 s), heavily lowpassed — the body is a wall the sound leans on |
| `moon`, `ringed` | short, medium-bright — a nearby mass, not a chamber |
| `sun` | dry and slightly bright — nothing to reflect from, everything lit |
| `bare` | bone dry. Silence is a reading. |
| comet tail (inside) | the room becomes noise: send fully wet, IR is band-limited hiss — instruments do not work in there, and neither does the ear |

**Positional echo.** The one part that is genuinely new: in a rocks sector, a
loud transient (kill, torpedo blast, mine, breach) **returns from the rocks
that are near it**, not from nowhere. Implementation: for the nearest 2–3
rocks to the event, schedule a delayed, filtered, attenuated copy of the
transient's *tail voice* (not the whole cue — the tail is one noise voice) at
`delay = 2 × distance / c_game` and pan by the rock's bearing from the player.
Three voices per echoed event, from a fixed echo budget (§4). The world's own
geometry becomes audible; a firefight in the field sounds like a firefight
in a canyon.

**Gated by measurement.** The convolver is one node and cheap; the positional
echoes are extra voices per loud event. §6.1 makes the budget check a
required prototype step before the positional half is committed — under
SwiftShader the harness will hide scenery, but a real machine in a wave-eight
fight in a rocks sector is the case to measure.

**Duck the world.** Alien: Isolation's rule from the research doc: as threat
rises, the *space* gets drier and quieter (the send drops), and the ship and
the threats get closer. Reverb is atmosphere; atmosphere gives way to
information. Restored between waves. That is gain-staging of attention, and it
costs no headroom.

---

## 2. The bench — what the ideas stand on

`Synth.ts` gains four things, all small, all in its existing idiom:

- **A third voice kind, `fm`**: one carrier + one modulator, `ratio` and a
  modulation `index` with its own decay. Metallic shield rings, the dock's
  modal clunk, and the Shroud's inharmonic swell all want it; the radio's
  carrier does not (it is a pulse through formants — see below).
- **A `formant` voice**: a carrier through 2–3 parallel bandpass filters
  whose centres sweep along a per-phrase contour, gated by a syllable
  envelope sequence. This is the radio's voice and nothing else's. Kept as
  its own kind rather than bending `tone`, because it is a phrase generator
  (a sequence of syllables on the audio clock) rather than one envelope.
- **A `space` send**: `ConvolverNode` fed by a per-bus send gain, IR
  regenerated at sector entry (`Synth.setSpace(ir: AudioBuffer)`), plus a
  master send level the ducking drives. Off (send 0) until a run starts.
- **Static voice budgets per bus** replacing the single `MAX_VOICES = 18`:
  bed 2, alert 1, weapon 3, impact 4, hostile 4, mechanism 2, panel 2,
  **radio 1 per party (3)**, **echo 3** — the four-channel-chip principle from
  the research doc, so a busy moment degrades predictably instead of to mud.
  A new bus is a new constant in `BUS_LEVELS`; the mix stays a handful of
  numbers in one place.
- **A duck primitive**: `Synth.duck(bus, depthDb, seconds)` — a smoothed gain
  dip on one bus, used by the radio (weapon bus dips a few dB while a phrase
  plays) and by the threat/space coupling.
- **The compressor question closed.** `todo.md` §4 says the 6 ms lookahead
  costs hit-stop sync; `Synth.ts`'s own comment says a `tanh` limiter already
  replaced it. Verify which is true and record it; if the compressor is gone,
  the todo entry closes.
- **Hit-stop marks the beds only.** `Session.timeScale` dips → a brief lowpass
  and pitch dip on bed voices, driven from wall-clock seconds like hit-stop
  itself; transients stay sharp.

## 3. The ship — the parts of the palette that make it legible

The research doc's §6, built where it makes the ship readable. Kept lean:
each item answers "what does this tell the player" or it is not here.

- **The reactor bed** (§6.1): two detuned oscillators ~0.4 Hz apart near
  58 Hz, lowpassed with a slow LFO, present from run start. Energy → cutoff and
  pitch droop; **starved** → an octave drop and a sparse relay tick; thrust →
  the brighter noise layer (exists) plus a small pitch bend; hull → roughness.
  The alert stays the pulse it became.
- **The scanner as a second ear** (§6.5): a sweep-return ping when the arm
  paints a contact, panned by bearing, in a band nothing else uses; unresolved
  returns detuned by positional error — rough when uncertain, **resolving to a
  clean tone as it tightens**. The decloak becomes the FM swell that resolves
  into the Shroud's timbre exactly when it can fire. (The radio's single
  squelch on commit and this swell are the two halves of the Shroud's tell —
  one says *someone keyed*, the other says *where*.)
- **Hostile identities** (§6.4): band and rhythm per class — Raider bright/
  thin/top band; Lance's rising resonant charge before the shot; Bastion low
  and heavy, duller bolt; Harrow audible laying (release, then the mine's
  arming click), armed mines ticking faster with proximity; chain detonations
  inheriting `chainFuse`'s stagger. Guards get a small pitch offset (their
  radio signature and their bolt agree).
- **Damage** (§6.7): shield absorb panned and pitched by facing, thinning as
  the facing depletes; breach gets the roughest sound in the game (70 Hz AM,
  under half a second) then a distinct descending figure for the multiplier
  halving.
- **Death** (§6.8): the long four-layer breakup with falling centroid while
  `power` drives every bed's cutoff and gain down the panel's own flicker
  curve; the shock ring as one low outward sweep; then **near-silence for the
  drift**, one relay tick at the scripted blip; then emergency power spooling
  up and the tally figure — the docking arpeggio lowered, slower, one note
  short.
- **The multiplier family and docking** (§6.6, §6.9): one motif in four
  registers — kill (deposit), HUD readout, salvage transfer, tally (payout).
  Docking scored to its stages: the A-N radio-range on approach (off-course a
  broken figure that **locks to a steady tone on course** — and it lives on
  the radio bus, because that is what it was), tractor, the hard-dock modal
  clunk, service steps, tally, departure.

## 4. Rules

- **Every cue answers "what does this tell the player."** If nothing, it
  belongs to the bed, the room, or it does not ship. This is the CHI finding
  as a rule; the radio and the acoustics pass it because both carry facts
  (who, where, what's there) the eye gets later or not at all.
- **Band discipline:** below 120 Hz reserved for alert/torpedo/mine/death;
  phasers above 700 Hz; nothing sustained in 2–5 kHz; **the radio owns
  300–3400 Hz for phrases only**.
- **Static budgets** (§2) are hard caps; the surplus is refused, not queued.
- **No samples, no speech, no words.** The radio's idiom is formants and
  squelch. A phrase that could be transcribed has failed.
- **The radio never orders, never carries information the board lacks.**
- **The space never carries information the eye lacks** — it is derived from
  the same plans the renderer draws.
- **Nothing pulses that isn't a hostile's own behaviour** — carried over from
  the visual rule; the reactor's breathing is slow enough to be breath.
- **Both synth rules survive:** nothing throws; nothing before a gesture. The
  convolver and formant nodes are built lazily inside the same guard.

## 5. Not in this spec (deliberately)

- The generative music layer (sub-project two). §7 lists what it needs from
  here.
- Turn-rate gyro whine (the doc's own "test whether it reads as a dentist's
  drill" — a tuning-sitting experiment, not a design).
- The chart's own voice (the NEBULOUS warning) — the chart is drawn over live
  combat and the mix does not move when it is raised, so the failure it
  warns of does not occur here; noted, not built.
- Any HUD or copy change. The radio's text is the dispatch text that exists.

## 6. Verification

### 6.1 The budget gate (before positional echo is committed)
On a real machine (not the harness), a wave-eight fight in a `rocks` sector
with the full radio and echo budgets live: `AudioContext` render-quantum
timing must show no glitches (`baseLatency`/`outputLatency` stable, no
audible dropouts) and total live nodes under a recorded ceiling. If it fails,
positional echo drops to the nearest **one** rock, and if that fails, to the
convolver alone — the fallback ladder is recorded in `todo.md`, not
improvised.

### 6.2 Assertions
- **audiotest** (bare node, mock context): contract rows for every new cue and
  each new voice kind; a **budget assertion** — voices per bus never exceed
  the static caps under a burst of every cue at once; the formant voice
  produces a syllable *sequence* on the audio clock, not timers; the space
  send is 0 before `start()`; nothing throws with no audio device.
- **playtest**: the radio fires on its events (a spawn produces a `theirs`
  phrase; a dispatch produces an `ours` preamble; a Warden hail produces its
  phrase) — observed through a probe-exposed `sound.lastPhrase` record, not
  by listening; the space's IR changes on sector change and is dry for
  `bare`; the send drops under threat.
- **typecheck**; the campaign build untouched (nothing here is chart logic).

### 6.3 The sitting
The honest test is the one your `todo.md` has always named: a human at the
keyboard with the speakers on. This spec is the first that gives that sitting
something to *say* about — is the room legible, is the radio a tell you can
learn, does the Shroud's squelch-then-swell make it survivable. Constants land
on the tuning list; the sitting is the review.

## 7. What the music layer will need from here

Reserved, so sub-project two does not have to reopen the bench: the `radio`
and `echo` buses and their caps; the space send (music will run *dry* — it is
not in the room); the per-sector seed hook (`planHero`'s mix is the model for
a `planKey`); the duck primitive (music ducks under radio); and a documented
scale/tuning table location. None of it is built here beyond the reservation.

## 8. Documents to amend on landing

- `CLAUDE.md`: the audio architecture line (bench: three voice kinds + formant
  + space; static budgets), the radio and the acoustics in State, and the
  "Next, in order" §2 audio-revision item closed or narrowed to what remains.
- `docs/todo.md`: §4 audio revision resolved item by item; the new constants
  on the §2 tuning list; the budget-gate result and fallback ladder recorded.
- `docs/audio-prior-art.md`: a dated addendum — what of §6 was built, what
  was changed and why (the radio and the room are additions the research did
  not propose; the doc should record that they came from asking "what would
  make it *singular*", not from the canon).
