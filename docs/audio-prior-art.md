# Prior art: how the machines made their noise

Research notes for the audio layer of *Kobayashi*. The rule for this document is
the rule for [prior-art.md](./prior-art.md): find out what an old machine
actually did, work out *why* it worked, and draw a line from that to what we
should build. Everything here has to end up as WebAudio oscillators, noise and
filters — there are no samples in this project and there never will be — so
"how was it generated" is not trivia here, it is the spec.

Sources at the bottom. Where a claim is folklore I have said so; arcade audio
history is badly contaminated with repeated anecdote and a fair amount of what
"everybody knows" turns out to be wrong when you read the disassembly.

---

## 1. The canon, technically

### The first vector games had no sound chip at all

This is the single most important fact about the era and it is usually told as a
curiosity. It is not a curiosity, it is the reason the sounds are good.

**Asteroids (Atari, 1979)** has thirteen sound effects and no sound processor.
Wendi Allen — then Howard Delman — built a discrete analog circuit for each one
by hand and wired it onto the board. Each effect is roughly a 555 timer, a
4016/4066 bilateral switch used as a gate, an inverter and a handful of passives,
summed into an LM324. The *fire* sound is a 555 in astable mode with a transistor
acting as a variable resistor on its timing network, so enabling the sound sweeps
its frequency and its amplitude together; a ~0.03 s RC time constant drops the
level. That is a laser sound: one oscillator, pitch and volume falling together,
thirty milliseconds. We are going to build exactly that in WebAudio, and the
reason it will sound right is that it is the same recipe.

**Lunar Lander (1979)** — Atari's first vector game — is likewise discrete. So is
the whole early **Cinematronics** vector line (*Space Wars*, *Star Castle*,
*Rip Off*, *Solar Quest*); MAME only got them right in 2020, when Aaron Giles
replaced the recorded-sample fudge with actual netlist simulation of the analog
boards. If a sound needs a SPICE-class circuit simulator to reproduce, that tells
you something about how much character was in the electronics rather than in the
data.

*What transfers:* an analog effect has no fixed length and no discrete state. It
has an envelope, and its pitch and its loudness are usually the same control
voltage. Nothing in Asteroids is a clip being played. This is the audio version
of a decision we already made on the visual side — the HUD is not text pasted on
top, it is strokes the ship draws — and it points at the same conclusion for
audio: **prefer a parameter you drive over an event you fire.**

### Then the POKEY, and a different kind of thinness

**Battlezone (1980)** is the hinge. It has a POKEY *and* discrete circuits, and
the split is instructive: the POKEY does the events, the analog board does the
machine. Documented POKEY allocation is channel 1 for collisions and the saucer,
channel 2 for the radar ping, the extra-life beeps and the "new enemy" alert, and
channels 3/4 for the **missile buzz**. The tank engine is not POKEY at all: an
"engine rev enable" line changes a voltage into an op-amp which retimes a 555,
which clocks a pair of LS161 counters. That is a hardware VCO, and it is why the
engine can rev continuously across frames rather than stepping.

Two things fall out of that. First, **the missile buzz is a threat drone**: a
continuous pitched tone that exists only while something is tracking you, on its
own pair of voices. That is a direct precedent for the alert drone we need.
Second, the reason Battlezone feels like being *inside* a machine rather than
watching one is that there is always a bed under everything — the engine never
stops, it only changes. Take the engine away and Battlezone is a slideshow with
pings on it.

**Tempest (1981)** runs two POKEYs for eight voices, and the POKEYs also read the
spinner and the DIP switches, because in 1981 a sound chip was also your I/O.
Worth knowing: in the self-test, "each tone is actually made of two identical
tones, one coming from each of the two POKEY chips", with a slight imperfection
audible partway through. Doubling a voice across two nominally identical
oscillators, with whatever drift the parts have, is a free thickener and it is
one line of WebAudio.

**Red Baron (1980)**, **Gravitar (1982)** and **Major Havoc (1983)** ride the same
curve; Major Havoc carries *four* POKEYs at 1.25 MHz. POKEY itself is worth
understanding because its architecture is unusually close to what we are about to
write: four channels, each an 8-bit divider off a 15 kHz / 64 kHz / 1.79 MHz
clock, 4-bit volume, channels pairable to 16 bits for low notes, high-pass
filters on two of them, and — the important part — a "distortion" selector that
routes the channel through 4-bit, 5-bit and 17-bit linear-feedback shift
registers in six combinations. POKEY's noise is not a noise *source*, it is the
same oscillator with a polynomial in the path. Pitched noise, in other words:
tone and grit on one control. That is a filtered-noise-plus-tone architecture and
we should copy its shape, including its parsimony.

### Star Wars (1983): four POKEYs and a talking cabinet

The Star Wars sound board is its own computer — a 68B09E, 16 KB of ROM holding
program, sound tables *and* the speech vocabulary, 2 KB of RAM, four POKEYs at
1.512 MHz, a TMS5220 LPC speech synthesiser at 640 kHz, a stereo image
synthesiser and 20 W of amplification into two 6×9 speakers.

The speech is the famous part and it is the part to be careful about. Sixteen
kilobytes total is not a lot of vocabulary, and LPC at that bitrate is a
distinctive kind of ugly — thin, buzzy, unmistakably a machine reciting. That is
precisely why it works: nobody in 1983 mistook it for Alec Guinness, and the
brain fills in the rest. Digitised speech that is *almost* real is uncanny;
speech that is obviously synthesised reads as your ship talking to you. Star
Wars is not cheap today — it is the good version of the trick, and the games that
have aged badly are the ones that used more bandwidth to get closer to a
recording.

We can take none of the content and all of the method. We are not going to
reproduce a single recognisable cue or motif from that cabinet — that is a locked
decision and it applies here exactly as it applies to hulls and insignia. What we
can take is: **a synthetic voice at obviously-synthetic fidelity is a legitimate
instrument**, and it is the only way to say a word without breaking the "no DOM
text" discipline, because a spoken word is not drawn on the screen.

Practically, for us, real LPC is out of scope. The reachable version is a
formant-synthesis buzz — a pulse-ish source through two or three resonant
bandpasses whose centre frequencies move — which produces speech-shaped noise
without producing words. See §5.

---

## 2. Why particular sounds worked

### The Asteroids heartbeat, from the source rather than the anecdote

This is the most important precedent we have, so I read the disassembly rather
than the retrospectives, and the received wisdom is partly wrong.

Delman's own account of the intent is quoted consistently: *"The boom-boom-boom
background sound was sort of meant to be like a heartbeat, and the idea was that
as the game progressed, the sound speeded up, and the player's heart would speed
up, too."*

What the code actually does (labels from the Mikstas disassembly of the program
ROM, cross-checked against the Computer Archaeology hardware map):

The CPU's entire sound interface is **six write-only latches**:

| Address | Name | Controls |
|---|---|---|
| `$3600` | `ExpPitchVol` | explosion pitch *and* volume, one byte |
| `$3A00` | `ThumpFreqVol` | thump frequency (low nibble) and enable/volume (bit 4) |
| `$3C00` | `SaucerSFX` | saucer on/off |
| `$3C01` | `SaucerFireSFX` | saucer firing |
| `$3C02` | `SaucerSFXSel` | large/small saucer pitch |
| `$3C03` | `ShipThrustSFX` | thrust on/off |
| `$3C04` | `ShipFireSFX` | ship firing |

Note what that is not. There is no "play sound" call anywhere in Asteroids.
There are seven bits of instrument state and one shared pitch/volume byte, and
the game keeps them up to date. The explosion register is the clearest case:
`ExplsnSFXTimer` counts down and is written straight to `ExpPitchVol`, so an
explosion's pitch and its loudness fall on the same ramp — which is what a real
explosion does, and which is a single line of code.

The thump itself, in `L7580`–`L75BC`:

- It is **on for a fixed 4 ticks** (`ThmpOnTime = $04`) and off for
  `ThumpOffTime`, reloaded from `ThmpOffReload`.
- `ThmpOffReload` starts at `$30` (48) at wave init and is decremented by one
  every 64 frames, floored at `$08` (8).
- So the period runs from 52 ticks to 12 ticks — call it ~0.87 s down to ~0.20 s
  at 60 Hz, or about 1.15 Hz up to 5 Hz — over roughly forty seconds of play.
  (The 60 Hz assumption is mine; it matches recordings but I did not verify the
  tick rate from the schematic.)
- The tempo is reset to slowest **at the start of each wave**, not gradually.
- Each time the thump switches on it does `EOR #$14` on the register value. `$10`
  is the enable bit; `$04` is a frequency bit. So every thump **toggles one bit
  of its own pitch** — which is why it is a two-note alternation and not a
  repeated blip.
- It is silenced outright when there are no asteroids left, when the ship is
  exploding, and when the ship is not on screen.

Three corrections to the folklore, then. **The tempo tracks elapsed time in the
wave, not the number of asteroids remaining** — the commonest statement about
this game's audio is simply not what the code does. **The note does not get
shorter; only the gap does** — the tension comes entirely from eating the
silence. And **the pitch alternation is one XOR**, the cheapest possible way to
stop a repeated sound reading as a stuck one.

The ancestor is **Space Invaders (1978)**, where the four descending bass notes
accelerate because the CPU moves one invader per frame and there are fewer
invaders to move — the acceleration really is emergent from the hardware there,
and Nishikado kept it. Asteroids is the version where somebody looked at that
and implemented the *feeling* deliberately, on a clock, decoupled from the
simulation. We want the Asteroids version.

*What transfers, precisely:*

1. Threat pacing is one low pulse. It needs no melody, no chord and no timbre
   work.
2. Hold the pulse length constant and shrink the gap. Duty cycle in Asteroids
   runs from about 8% to 33% — it is mostly silence even at maximum.
3. Alternate two pitches a fixed small interval apart, so a repeat reads as a
   machine working rather than a loop.
4. Reset per wave, so escalation is felt again rather than being a ratchet.
5. Cut it dead for the two loudest events in the game: the wave clearing, and
   your ship coming apart.

### Battlezone: the bed and the buzz

Covered above; the two design facts are worth restating as rules. A continuous,
slowly-modulated bed is what converts "graphics with sound effects" into "a
machine you are sitting in", and it costs one voice. And a threat that is
tracking you should own a *continuous* voice rather than a repeated alert, so
that the player learns its presence rather than counting its beeps.

### Tempest: aggression, and the limits of what I could verify

Tempest is loud, atonal and mostly in the upper-mids, and it does not let up.
I can verify the hardware (two POKEYs, eight voices, doubled tones, POKEY also
handling the spinner) and I can verify Minter has been rebuilding the aesthetic
since Tempest 2000. I could **not** find a documented per-effect breakdown — no
disassembly-level source describing which voice belongs to a Flipper, whether
enemy pitch maps to depth in the tube, or how the Superzapper is built. The
common claim that Tempest's sound "reinforces the tube's depth" is, as far as I
can establish, an observation people make rather than a documented design
decision. I am not going to build on it. What is safe to take is the negative
lesson: Tempest is at the edge of tolerable, and it gets away with it because a
session is three minutes. Ours is ten. We do not have Tempest's licence to be
relentless.

### Star Wars: motif, and why we cannot use it

The other half of the Star Wars cabinet's audio identity is that it plays music
you already know. That is the single largest audio asset the game has and it is
exactly the thing the "our own universe" decision forbids us. Worth naming
explicitly so nobody reaches for it by reflex: no fanfares, no quotes, no
"inspired by" three-note stingers that anyone could name. The transferable part
is structural — a *recurring short figure tied to a state* is enormously
efficient, and we can invent our own.

---

## 3. What the modern descendants actually added

The expectation going in was that Tempest 4000, Geometry Wars, Resogun, Nex
Machina, Thumper and Rez would be full of adaptive systems the 1980 machines
could not build, and that the job was to pick the good ones. That is mostly not
what the record shows, and the negative finding is more useful than the positive
one would have been.

**A warning about this section's evidence base.** The neon/twin-stick corner is
far thinner in primary sources than its cultural weight suggests. There is no GDC
audio talk, no *Designing Sound* or *A Sound Effect* feature, and no composer
interview for **any** of Geometry Wars, Resogun or Nex Machina. Rez and Thumper
are well documented; the rest is reconstructed from designer interviews that were
about something else, review copy, and asset filenames. Several widely repeated
claims turn out to have no source at all. Everything below is marked accordingly,
and §"What could not be verified" carries the full ledger.

### The neon canon is far less systemic than its reputation

- **Tempest 2000 (1994), TxK (2014), Tempest 4000 (2018)** — no reactive audio in
  any of them that I could find documented. T2K's contribution was cultural:
  rave-tempo techno under an arcade game when nobody was doing that. The music is
  linear tracker playback; the reactive elements are vocal callouts on events.
  I am asserting a negative here, so treat it as such.
- **Polybius (2017)** — the "beat-synced shaders" story is not true. Thirty-three
  pre-composed tracks by an outside collective; Minter's own manual for the game
  mentions sound, music and audio **zero times**, and his announcement post is
  entirely about light and geometry.
- **Resogun (2013)** — Harry Krueger's own 41-minute postmortem is obsessive
  about voxels and GPU compute and contains **no description of the audio system
  at all**. Any claim that Resogun has a documented adaptive audio architecture
  is folklore. Its one genuinely post-1980 move is routing the vocoded "save the
  last humans" partly through the DualShock 4 speaker — a second near-field
  channel in the player's hands.
- **Nex Machina (2017)** — the design deep-dive on maintaining readability solves
  it entirely through spawn rhythm, grouping, colour-coded space and silhouettes.
  **Audio is never mentioned.** And reviewers note the score holds a *constant*
  tempo, which is a deliberate non-adaptive choice: a stable pulse the player
  syncs to rather than a system moving under them.
- **Geometry Wars** — Stephen Cakebread on Waves mode: *"The audio track only
  lasts two minutes. If you're alive that long, it's not something you're paying
  attention to!"* A designer conceding the music is beneath conscious notice at
  high skill.

### Great music, weak signal — the failure mode to name out loud

Resogun's soundtrack was widely acclaimed. GamesBeat nonetheless concluded that
**"the audio cues aren't obvious enough to be helpful,"** and tied that directly
to the game's steep learning curve; Game Informer called the sound
*"forgettable-yet-appropriate."* Set that against Bizarre Creations building
per-enemy spawn timbres in **2003** that expert players demonstrably used as
tactical information, while the same studio's designer says the music itself goes
unnoticed at high skill.

That contrast is the spine of everything in §6. **Spawn cues get read; music does
not.** A beautiful bed that carries no information is the most expensive way to
fill frequency space there is, and it is the default outcome if we start from
"the game is silent, add sound." Every element we build should be answerable to
the question *what does this tell the player that they could not otherwise
know* — and if the answer is "nothing", it belongs to the bed, at the bed's
volume, or not at all.

### What does work, with evidence

**1. Per-enemy spawn timbres as tactical cues.** From Bizarre Creations' own
GameCity talk, reported by Gamasutra in 2008, describing behaviour that shipped
in the 2003 *Project Gotham Racing 2* easter-egg build: *"Individual enemies had
unique spawning sounds, and experienced players were able to use these as cues
that enhanced their play."* This is the single best-evidenced finding in the
modern cluster, it predates every adaptive system anybody built, and it costs
nothing. We have five hostile classes that already own five hues. They should own
five spawn sounds, and those sounds should be legible with your eyes elsewhere.

**2. Tune everything to one key.** Rez's real innovation, per Mizuguchi at GDC
2016, is quantisation: *"Even if a player wasn't great at matching their
interactions with the beat, quantization would synch the rhythms of play and make
you feel good… This became the essence of perfecting the game mechanics of Rez."*
Two caveats before we copy it. First, nobody has cleanly established whether
Rez's *hit registration* is delayed or only its audio — assume audio only.
Second, and much more importantly:

**3. Rez's defence against rapid-fire fatigue is mechanical, not acoustic.** You
*hold* to lock up to eight targets and *release* a volley; there is no meaningful
single-tap spam. The input grammar produces phrases rather than streams, and the
audio system is downstream of that. We do not have that luxury — our trigger
fires every 0.16 s and the design is not going to change to suit the mixer. So
Rez tells us less about our specific problem than it looks like it does, and the
transferable half is only "everything is in the same scale".

Mizuguchi's own lineage hedges further: Hydelic state that Tetris Effect's music
does **not** require piece drops to be beat-synced. So the durable principle is
*tune to the key*, with *snap the timing* as an optional stronger move.

The only direct measurement of this I found is Bjørn Jacobsen's informal test —
nineteen players, ten on an out-of-tune build and nine on an in-tune build,
playing until they wanted to stop; the out-of-tune group quit one to two minutes
earlier. n=19 and self-reported, so weak, but it is the only number anyone has
put on the Rez principle.

**4. Thumper's pre-echo call-outs.** Each obstacle type has a distinct audible
warning ahead of it, giving *"a few vital sub-seconds to prepare for the
succession of button presses ahead"* — a substitute HUD for a game whose visuals
are deliberately illegible. Drool's stated method is that *"we try to limit the
distinction between music and sound effects"* and that *"percussive instruments
are just two solid objects hitting each other. In our gameplay, there are many
collisions between objects and we use them as musical opportunities."* Their
music and level data are authored on the same timeline in the same editor.

Also from Thumper, and directly relevant to our death sequence: on failure *"the
background percussion and your attempts at rhythm fall silent, replaced with the
grating sound of machinery gone wrong."* Losing removes the groove.

**5. Returnal's technique statement**, which is the rigorous account of
many-simultaneous-events the twin-stick canon otherwise entirely lacks. Simon
Gumbleton: *"originally every bullet was posting an event, which quickly became
unmanageable. Instead, projectiles are filtered and prioritized based on
proximity and velocity."* Loic Couthier: *"There is a lot of voice limiting… and
pre-Wwise culling systems too,"* with a priority system where higher-priority
sounds duck lower ones — *"Much of mixing the game was to define what sound
needed what priority in what context."* The thesis: *"You need to hear everything
around you when you play, otherwise you're dead."* Different team from
Housemarque, so it does not retroactively describe Resogun; but it is the model.

### The finding that should govern everything

**Kao, Ballou, Gerling, Breitsohl & Deterding, CHI 2024** — pre-registered,
**n = 1,699**, in a purpose-built action RPG, independently varying feedback
*amplification*, *success-dependence* and *variability*.

- **Variability was the strongest predictor of enjoyment and the only predictor
  of playtime.**
- **Success-dependence enhanced every motive measured.**
- **Raw amplification *negatively* impacted effectance and competence.**

Their conclusion, verbatim: *"There can therefore be 'too much of a good thing'
in amplified feedback where it occludes causal action-feedback links or flattens
success gradations."*

Translated into our terms: feedback that **differentiates outcomes** — shield hit
versus hull hit versus kill versus multiplier tick versus a phaser that landed
out of range — earns its place. Feedback that is merely louder, denser or more
layered actively costs us. That is the opposite of the instinct one has when the
game is currently silent and the temptation is to fill it.

A smaller corroborating study (Smets & van der Spek, 2021, n=61) found juicy
audio treatments produced significantly greater immersion and sensory fidelity at
medium effect size — so the answer is not "less audio", it is "differentiated
audio". Note also that the CHI PLAY 2019 study frequently cited for an
inverted-U curve is about **visual** embellishments only and its results are
equivocal; it is not evidence about sound.

### And the cautionary tale, which is on-brand for this project

**Space Giraffe (2007).** Minter built it on Neon, a music visualiser, and is
candid that *"the background effects are mildly audio reactive but the music
doesn't actually alter gameplay."* Dan Amrich reviewed it at 2/10 for OXM because
players *"frequently die because you couldn't pick out the pulsating assassin
from the warped playfield floating over the throbbing LSD nightmare that is the
background"*; it sold on the order of ten thousand copies in two weeks, and the
PC version had to rework Neon to be *"less psychedelic and easier to see what's
going on."*

**Audio-reactive presentation that competes with the gameplay layer for attention
is a documented failure mode**, from the person who has thought about this longer
than anyone. That is the same argument as our locked "occluded geometry, not pure
wireframe" decision, arriving from the other direction. Where Minter's reactive
thinking finally works is Akka Arrh (2023), where he *"built a very simple little
sequencer-thing that plays samples from instruments and this grab bag of sounds
based on what is happening in the game… a tonal sequence that is generated by the
enemies, and by your actions as you shoot the enemies."* His own verdict:
*"'music' is too grand a word, but I actually quite like the result."* That
modesty is about the right ambition level for us — though note it plays *samples*
from instruments, which is the one thing we have ruled out, so we would be
building the same idea from oscillators.

---

## 4. Diegetic instruments: what it sounds like when the ship is producing it

Our conceit is that everything the player reads is something the ship is drawing.
The audio equivalent is the most transferable body of work in this document.

### FTL — the simple system that beat the complicated one

Ben Prunty's account of the two-version music system, from his AMA:

> *"I would make the Explore version first, then go back and add percussion, a
> bass line, or whatever else I needed for the Battle version… when it came time
> to finalize the tracks, I would mute the Battle stuff, export the project to
> wav, then go back and unmute the Battle parts and export it again… **Then it
> would just play both of them at once but keep one of them at zero volume.**
> When a transition would happen, it would crossfade."*

One DAW timeline, bounced twice with different mutes, so tempo, key and bar
positions match structurally rather than by discipline. The engine side is about
fifteen lines of XML. And the part worth carrying: *"**The FTL team's original
suggestion was a much more complicated dynamic system… and I bargained it down to
the two track system.** It's very simple and very effective."*

Two things transfer directly.

**Bind audio to outcome, not to event.** FTL's weapon audio is declared as
`launchSounds` / `hitShipSounds` / `hitShieldSounds` / `missSounds`. Shield-hit
and hull-hit being genuinely different sounds is why experienced FTL players say
they fight the game by ear. We are set up for exactly this and are not using it:
`Ordnance.discharge(from, to, hit)` already carries the outcome, and
`Ship.takeHit` already knows which of four facings absorbed and whether anything
reached the hull. This is also precisely the "success-dependence" variable that
CHI 2024 found enhanced every motive.

**One person doing both music and effects is why FTL sounds like one machine
rather than a score plus a library.** Prunty made every sound himself, in a
closet. We have the same opportunity and the opposite constraint — one synthesis
engine, no samples at all — which pushes even harder in the same direction.

### Duskers — no soundtrack, on purpose

Tim Keenan, on his own blog: *"a soundtrack felt non-diegetic and would hurt the
immersion of listening to a lone drone steer down an abandoned corridor."* And in
interview: *"We give you less information, and make it harder to perceive, and
that makes the player more uncomfortable."*

Three mechanisms, all of which we can afford:

**Two listening positions.** The schematic/map view hears *global* hull sound —
creaks, groans, distant clangs. The drone view hears *local* sound — the whirring
of the machine you are riding. We have exactly this split: the forward view and
the overhead scanner, sitting side by side, permanently. The scanner should have
its own sound, and it should be a different *kind* of sound, not a quieter mix of
the same one.

**Sound propagates through the topology, not just through distance.** A Duskers
patch note records that an enemy-code optimisation had the side effect that
*"sounds don't travel through doors"* — and the developer flagged it as a
**regression** to be restored, because you could no longer hear swarms in the
next room. Our topology is not rooms, it is range and bearing on a plane, but the
principle holds: what makes an unseen threat legible without a HUD marker is that
its sound reaches you *through the world*, attenuated in a way that tells you
something, rather than being switched off at a radius.

**Warn before, and do not say where.** Duskers creaks the hull 15–30 seconds
before a radiation leak floods a room, never names the room, and does not always
follow through. That is a warning that raises the *quality* of your attention
without doing your thinking for you — which is the exact brief for the Shroud.

Caveat: nobody has stated whether Duskers' degraded, filtered quality is
real-time DSP or baked into assets. Do not repeat that it is a live low-pass on
the drone bus; it is how you would build it, but it is not documented.

### Alien: Isolation — the motion tracker, and why it is fair

Byron Bullock on the tracker, to the BBC: *"**It's almost like a heartbeat to it
— it gets faster and faster and higher in pitch. That can make you feel
anxious.**"* Rate **and** pitch both rise; the model is explicitly a heartbeat.
Note that this is the same instinct as Delman's in 1979, arrived at
independently thirty-five years later, and it adds one axis Asteroids did not
have.

The theoretical account of why it is fair rather than cheap is the best single
sentence in this research, from Jaroslav Švelch in *Game Studies*:

> *"**Its limited range and resolution convey the idea that the station always
> contains spaces that are unaccounted for.**"*

**The tracker's job is not to reduce uncertainty but to bound it.** A blip that
could be a duct, a floor below, an android or the Alien is strictly *more*
frightening than no blip, because it converts diffuse anxiety into a specific
unresolved question. Four properties do the work together, and we already have
three of them in the scanner:

1. **Deliberate incompleteness.** Directional only, **no vertical axis**, no
   classification. Ours: a cloaked hull exists only when the arm crosses it, is
   placed with real positional error, and decays over three seconds.
2. **It costs you.** Raising the tracker pulls focus, blurs the world, and emits
   a small AI-audible noise — *in the same currency as the threat it warns you
   about*. We have no equivalent, and probably should not invent one: our
   scanner is half the interface and taxing it would break the 1982 split-display
   contract. Worth naming as a deliberate divergence rather than an oversight.
3. **The information is true.** Jeff van Dyck: *"When the alien was up in the
   vents and stuff, **he actually is up there**… all the sound he makes sounds
   correct and in the correct location."* Nothing is a scripted stinger
   pretending to be a sensor reading. This is already our locked position on the
   scanner — no false returns, because ambiguity from staleness and error teaches
   you something and a phantom only teaches you to distrust the instrument.
4. **The AI never cheats**, and the tracker is the instrument through which
   players *audit* that fairness.

Four more findings from that team that change specific recommendations:

- **Distance is a band-pass, not a low-pass.** Van Dyck: *"**High frequencies
  start to roll off and also low frequencies start to roll off** and essentially
  a sound becomes thinner and thinner-sounding as it gets off in the distance.
  If you don't apply those effects artificially the soundscape sounds wrong."*
  Plus, source **width narrows with distance and widens as it approaches**. Two
  cheap parameters give readable range from timbre alone — which matters enormously
  for us, because phaser damage already falls off with range and we want that
  audible.
- **The mix is driven by two continuous state values — `stealth` and `threat` —
  and it works by ducking the world and raising you.** Bullock: *"We will lower
  the atmosphere and raise up the Alien's sounds and Ripley's breathing rate… we'll
  start to raise up your sounds a little bit just to put you on edge."* That is
  gain-staging of *attention*, and it is a better answer than turning the alert
  up.
- **Music is line-of-sight gated so the score cannot leak information**, and
  Alien vocalisations were deliberately mixed into ordinary door sounds to
  produce false positives — *"You think the alien's in there because you kind of
  hear it."* We have ruled out false scanner returns for good reasons; note that
  a false *feeling* is a different thing from a false *reading*, and the second
  is what we banned.
- **"We've not been afraid to use quiet and silence."**

One correction worth recording: the popular claim that using the tracker makes
you a beacon overstates it. The shipped behaviour-tree data shows it *"only makes
audible noise that other NPCs can hear within a very short radius."* And the
game's lo-fi is a **render setting, not a recording constraint** — Sam Cooper:
*"We created high-quality source and degraded it using plug-ins afterwards so
that we always had the original to go back to."* Their in-house name for it was
*"Lo-Fi Sci-Fi"*. Build clean, degrade at the end, keep the clean version.

### Elite Dangerous — the ship as the instrument that renders the world

Matthew Florianz, on Frontier's own site, states the conceit outright:

> *"Jim and Joe made the right call in going for what **'feels' right, rather
> than what is physically correct**. **The speaker array inside the cockpit
> simulates all audio happenings in real-time, and the original idea surfaces
> when you lose your cockpit glass and all audio no longer has air to resonate
> with.**"*

Rather than excuse game audio as non-diegetic licence, they made the ship an
instrument that renders the world as sound — **and the canopy breach is the
proof.** When the speakers stop working you are left with helmet breathing and
muffled comms, which retroactively certifies everything you heard before it. That
is exactly the move our death sequence is already making visually, with the
instruments browning out as one failing supply.

Four things to take:

**A written technology fiction constrains the palette.** Florianz's audio pillar
is "robust technology": *"It would have to be robust, reliable, easy to maintain…
a robust space-capable ship would **not reach for hyper sophisticated technology
(modern FM based UI sound design)**."* He won the argument internally by *"writing
a fictional article about the development and acceptance of holographic displays
during the 34th century."* We already have the visual half of this fiction —
phosphor, CRT glass, occluded geometry, a stroke font. The audio has to belong to
the same machine, which rules out clean modern UI design as firmly as it rules
out LCARS.

**Re-parameterise by perception, not by SI units.** Joe Hogan on supercruise:
*"When measuring speeds in multiples of the speed of light and distances in light
seconds, **audio just doesn't make sense any more**… we ended up measuring
everything according to the human perception of what is happening rather than
actual science. For example, the distance to a planet is measured in
multiples-of-planet-radius (how big it looks) rather than meters… and we measure
the relative-speed of objects using **time-to-arrival (in seconds)**, rather than
meters per second."* Our docking guidance should be driven by *time to the gate*
and *fraction of the corridor remaining*, not by the metres and metres-per-second
that `DockGuidance` currently carries.

**Sonic branding across a game loop.** *"When comparable activities are
undertaken, those are accompanied by similar sound signatures… **Repeating audio
during progression of a game-loop constantly hints towards the pay-off much
later**… for explorers, selling data could take months! Such a delayed reward
made it extra important that the audio for scanning feels as rewarding (if not
more so) as selling the data does."* This is our multiplier, exactly. The sound
of a kill raising the multiplier, the sound of the multiplier readout, and the
sound of the tally that finally realises it should be **the same family of
sound in three registers**, so that every kill is audibly a deposit against a
payout that has not happened yet.

**And a mixing note**: *"We wanted our weapons to sound **large and clunky
instead of slick and all-powerful** because combat is strategic rather than
twitchy… Our sounds are designed to work best the moment you press a button or
pull a trigger."*

### NEBULOUS: Fleet Command — one useful accident

Almost nothing is documented. The one finding worth the space is a failure:
combat audio is world-space with steep falloff and the camera normally sits in
tactical view, so players hear almost nothing — *"a space battle from a silent
movie."* Honest distance modelling that became uninformative. Duskers solved the
same problem by making the far view *sound like a hull sensor* rather than sound
like nothing. Our scanner is a far view sitting permanently next to a near one,
so this is a live risk and Duskers has the answer.

## 5. The craft: how these sounds are actually made

This section is the one to read before writing code. Everything here is
reachable with `OscillatorNode`, `AudioBufferSourceNode`, `BiquadFilterNode` and
`GainNode`.

### sfxr is the primary source, and it is a source, not a toy

DrPetter's **sfxr** (2007) and its ports (jsfxr, Bfxr) are the best available
documentation of what an arcade sound effect *is*, because the presets are
literally the recipes expressed as parameter ranges. Reading `main.cpp` is worth
an afternoon.

The engine: an oscillator (square with variable duty / saw / sine / noise) run at
8× oversampling, a period that multiplies by a constant every sample
(exponential pitch slide), a second-order term on the slide, a Chamberlin
state-variable lowpass with its own sweep and resonance, a highpass, an
attack/sustain/punch/decay envelope, and two discrete gestures — a one-shot pitch
jump ("arpeggio") and a full retrigger ("repeat speed") that restarts pitch but
*not* the amplitude envelope.

Converted to real units, the **Laser/Shoot** preset says a laser is:

- start **885–3531 Hz** (or 321–2860 Hz for the harsher variant),
- **exponential** downsweep of one to eight octaves,
- into a **floor frequency that kills the sound** when it is reached — that hard
  stop is what makes it a zap and not a fade,
- **zero attack**, sustain 23–204 ms, decay 0–363 ms; **total 25–550 ms**,
- square or saw, often with a duty sweep,
- optional highpass to thin it out of the way of everything else,
- **and no noise layer at all.** The grit is the square's harmonics plus, in a
  third of cases, a phaser/flanger.

That last point is worth pausing on, because "falling oscillator plus noise
burst" is the folk recipe and sfxr does not do it. Noise in a laser buys you
nothing that a resonant filter sweep does not buy more cheaply and more
controllably.

The **Explosion** preset is noise-based, but note *which* noise: sfxr's "noise"
waveform is a 32-entry sample-and-hold refreshed once per oscillator period, so
it is **pitched** noise and the downward frequency ramp is a **spectral centroid
sweep**. In WebAudio that is a 32-frame `AudioBuffer` of random values, looped,
with an exponential `playbackRate` ramp downward. It is four lines and it is the
cheapest good explosion available.

### FM, for anything metallic

Chowning's 1973 paper is free and short. `y = A(t)·sin(2π·fc·t + I(t)·sin(2π·fm·t))`,
sidebands at `fc ± k·fm`, roughly `I+1` significant pairs — so the **modulation
index envelope is a spectral envelope**, and it costs one `GainNode` where a
filter sweep would cost a filter.

Chowning's own bell is `fc = 200`, `fm = 280` — **ratio 1 : 1.4** — with amplitude
*and* index both decaying exponentially, so the sound goes dense-and-bright and
settles into a pure sine. That settling is the entire illusion. His wood drum is
1 : 0.6875 with a fast decay; his brass is 1 : 1 with the index envelope tracking
amplitude.

Useful ratios: **1:1** harmonic and never metallic; **1:2** hollow; **1:1.4**
Chowning's bell, dense but still pitched; **1:1.618** maximally non-repeating,
the choice for a clang with no pitch; **1:3.5** or **1:7.7** sparse and thin, for
a latch or a spring.

Two implementation notes that will otherwise cost an hour: connect the modulator
to **`carrier.frequency`**, not `carrier.detune` — the latter is exponential FM
and the ratio stops being stable as the carrier moves. And the modulator's gain
is in **Hz**, so `gain = I × fm`.

### Explosions are a centroid trajectory, not a volume

Three physical facts converge, which is why the cue is so robust: air absorbs
high frequencies faster than low with distance; bigger radiating bodies have
lower modes; and the event itself starts as a broadband shock and decays into
roar and reverberation. So **size and distance live in the spectral centroid
over time, not in level** — and level is not ours to control anyway, since the
player owns the volume knob.

A four-layer build, all fired at the same instant:

| Layer | Source | Filter | Envelope |
|---|---|---|---|
| crack | white noise | highpass 900 → 300 Hz | attack 1–3 ms, decay 60–120 ms |
| body | brown/pink noise | lowpass Q 1–3, cutoff sweeping down | attack 5 ms, decay = the event |
| thump | sine | none | 90 → 35 Hz over 150–300 ms |
| tail | brown noise | lowpass < 200 Hz, slow LFO on cutoff | attack 80 ms, decay 1.5–3 s |

Small versus big is the sweep, not the gain: a small pop is 8000 → 1500 Hz over
180 ms with no sub and no tail; a capital-ship death is 5000 → 120 Hz over 2 s
with both. Add sfxr's *punch* — 1.8× for the first 15 ms — or the big one is a
whoosh.

**For distance, use a band-pass and not a lowpass.** This is the most immediately
actionable technical detail in the whole corpus and it comes from Alien:
Isolation's audio director (§4): with range, the high **and** the low frequencies
both roll off, so a distant sound gets *thinner at both ends*, not merely duller.
Their second parameter is apparent **stereo width, which narrows with distance
and widens as the source approaches**. Together those two give readable range
from timbre alone, with two cheap `AudioParam`s and no attenuation curve at all —
which matters for us because phaser damage already falls off with distance and we
want that rule audible rather than merely quieter. Also decay layer A faster than
layer B with range, and add 20–60 ms of pre-delay.

### Clunks are modal, and the maths is one line

A struck object is a 1–5 ms broadband impulse through a small bank of
exponentially decaying resonators. Three to eight modes, never forty. Material is
carried by the **ratios between modes** and by **decay times**, and almost
nothing else.

The relation you actually need, because `BiquadFilterNode` gives you `Q` and you
think in decay times:

```
T60 ≈ 2.20 · Q / f0          ⇔          Q ≈ T60 · f0 / 2.20
```

Ratio sets, from the acoustics literature: a **free–free bar** (metal rod, latch
tongue) is **1 : 2.756 : 5.404 : 8.93**; a **membrane** is **1 : 1.5 : 2 : 2.5**;
a **plate or shell** is effectively random above the first few, so use
non-integers like 1 : 1.41 : 1.83 : 2.29 and let a short tail do the rest.
**Tubular bells** sit in rough 2 : 3 : 4 ratios and the ear fuses them into a
virtual fundamental *an octave below the lowest partial present* — which means
you can imply an enormous low bell while generating no low energy at all. That is
a very useful trick on laptop speakers.

Metallic latch versus dull thud, which is exactly the docking clamp question:

| | Dull thud (mass seating) | Metallic latch (clamp engaging) |
|---|---|---|
| Ratios | 1 : 1.59 : 2.14 | 1 : 2.756 : 5.404 |
| Fundamental | 90–200 Hz | 900–2500 Hz |
| T60 of mode 1 | 60–120 ms | 250–600 ms |
| Q at f0 | ≈ 5–10 | ≈ 150–500 |
| Excitation | 5–8 ms noise, lowpassed at 1.5 kHz | 1–2 ms noise, not lowpassed |
| Extra | +sine at 55–70 Hz for 150 ms | +second strike 25–45 ms later at −9 dB |

That last row matters more than it looks. Real latches, bolts and clamps never
make one contact. **Two impulses 20–60 ms apart** is the difference between a
sound effect and a mechanism.

For four to six modes, additive sines with per-mode exponential decays are
cheaper to reason about than a bandpass bank and avoid the Q/gain coupling that
will otherwise clip you.

### Drones: the psychoacoustics, with numbers

This is the section that decides whether the alert is tolerable for ten minutes.

- **Roughness** — amplitude modulation in roughly the **15–300 Hz** band, peaking
  at **70 Hz** — is the physical correlate of "harsh". **Fluctuation strength**
  peaks much lower, at **4 Hz**, and is heard as pulsing rather than harshness.
- Arnal et al. (*Current Biology*, 2015) found that speech modulates at 4–5 Hz
  while **screams and artificial alarms both occupy 30–150 Hz**, that roughness
  rating predicts rated fear, and that it drives amygdala response rather than
  just auditory cortex. Their 2019 follow-up narrowed it: **aversion peaks at
  40 Hz** and stays elevated across 40–80 Hz.
- Plomp & Levelt (1965): two tones are maximally dissonant at about **a quarter
  of a critical bandwidth** apart. Critical bandwidth is ~100 Hz below 500 Hz and
  ~20% of centre frequency above. So near 300 Hz, maximum roughness is about
  **25 Hz** of separation; near 2 kHz it needs about **100 Hz**.
- Consequently: **the minor second is genuinely rough in the low register** (a
  semitone below 500 Hz is well inside one critical band) and the **tritone is
  not rough at all** — its menace is cultural convention, not physiology. Use the
  low minor second when you want dread you cannot argue with.
- **Why mid frequencies fatigue.** The ear canal resonates near 3 kHz and the
  equal-loudness contours peak at **2–5 kHz**. Sustained energy there is loud for
  its physical level and exhausts listeners fastest. **Keep the sustained body of
  any drone below 500 Hz and reserve 2–5 kHz for transients only.** That single
  split is most of the difference between a drone you can leave running and one
  that gets muted.
- **Adaptation is the real enemy.** The FAA's human-factors standard puts it
  plainly: the auditory system adapts quickly to continuous stimulation, so
  warnings should be **intermittent, not continuous** — which is, of course,
  exactly what Asteroids does. A slow filter LFO at **0.05–0.25 Hz** keeps a bed
  from being static without becoming a rhythm.
- **Map threat to modulation rate, and intensity to modulation depth — not to
  volume.** 2–4 Hz reads as attention, 8–16 Hz as urgent, 30–70 Hz as
  physiological alarm. 15% depth at 40 Hz is tense; 100% depth at 40 Hz is a
  klaxon nobody will tolerate for ten seconds.

**Shepard tone / Risset glissando.** Six to ten sines an octave apart, amplitudes
set by a fixed Gaussian envelope in log-frequency centred around 300–800 Hz, all
swept together; after exactly one octave the spectrum is identical, so it loops
seamlessly and rises forever. Ten oscillators and a shared phase variable. It is
the highest-value "this is escalating" device available and it is nearly free.
The warning is that it is *designed* not to resolve, which makes it the most
fatiguing thing on this list — run it during escalation only, and give it a real
resolution when the wave breaks.

### Alarms: Patterson, and why our alert should look like his

Roy Patterson's aircraft auditory-warning work (CAA Paper 82017, 1982; the freely
readable version is his 1990 *Phil. Trans. R. Soc.* paper) is the foundational
text, and almost every number in it is directly usable.

- Structure is **pulse → burst → warning**. A pulse is a shaped tone; a burst is
  a set of pulses with a distinctive *rhythm*; a warning is a set of bursts at
  varying urgency.
- **Rise time 20 ms.** Existing flight-deck warnings that went from off to over
  100 dB in under 10 ms triggered an involuntary **startle reflex**, and startled
  responses "often prove incorrect". A game equivalent: a warning that makes the
  player flinch makes them fly worse, which is not the same as making them
  nervous.
- **Four or more spectral components, each 15 dB above masked threshold**, spread
  across the spectrum, so a single competing noise source cannot mask the
  warning. Our competing noise source is a held phaser trigger.
- The perceived pitch of a warning is **inferred from the harmonic series implied
  by the components** — so you can place its pitch anywhere without generating
  energy there. Same trick as tubular bells.
- **Rhythm distinguishes, timbre does not.** Patterson's confusion analysis found
  that warnings sharing a pulse-repetition rate get confused *even with gross
  spectral differences*. If we want the player to tell two alerts apart, they
  must have different rhythms, not different colours.
- **Startle avoidance within a burst:** first pulse at a reduced level, then
  increasing; rounded pulse tops rather than flat.
- **The exhaustion problem is solved explicitly.** After the first urgent burst,
  further repetition in urgent form "would be needlessly irritating" — so drop
  pitch, level and speed, and extend the inter-burst interval to about **four
  seconds**, returning to the urgent form only when the situation changes. This
  is precisely the shape a ten-minute run needs, and it is the one thing the
  Asteroids thump does *not* do.
- **No more than six warnings in the set.** Naive listeners learn four to six
  quickly and then acquisition "slows markedly". The FAA's version is ≤4 for
  absolute identification.

Build the harmonic stack with one `OscillatorNode` and `setPeriodicWave` rather
than five oscillators — one node, one envelope, no phase drift between partials.

### WebAudio practicalities that will otherwise cost a day

- **Reuse the `AudioBuffer`, never the node.** `AudioBufferSourceNode` is
  one-shot by spec. Build one two-second white-noise buffer at init and share it
  for the life of the app; randomise `playbackRate` (0.85–1.2) and the `offset`
  argument to `start()` for free variation at zero allocation.
- **`exponentialRampToValueAtTime` cannot touch zero** — both endpoints must be
  strictly positive. Ramp to `0.0001`, then `setValueAtTime(0, …)` at the same
  instant. Or use `setTargetAtTime`, which *can* target zero.
- **Never step a gain from 0 to 1.** A discontinuity is a broadband impulse you
  did not ask for. Minimum 2 ms ramp; 3–5 ms is inaudible and safe. Always anchor
  with `setValueAtTime(current, t)` before a ramp, or it starts from whatever the
  last scheduled event left behind.
- **DC offset** comes from duty ≠ 0.5 pulses and from short random buffers with a
  non-zero mean. A **highpass at 20–25 Hz on the master bus** and it never
  bothers you again.
- **The real cost is AudioParam automation events, not nodes.** Non-Gecko engines
  linearly scan the event list, so a long-lived node accumulating thousands of
  scheduled events degrades over time. Creating a fresh `GainNode` per shot
  avoids this; a single persistent master envelope node you keep scheduling onto
  is the anti-pattern. Do `node.onended = () => node.disconnect()`.
- **Cap voices per category and drop rather than steal.** A dropped shot in a
  dense moment is imperceptible; a click from an interrupted one is not.
- **One limiter for the whole game**, because synthesised transients have brutal
  crest factors and the destination node hard-clips, which sounds like a fault
  rather than like distortion. `DynamicsCompressorNode` costs a fixed **6 ms of
  latency**, which will smear impact/visual sync; a `WaveShaperNode` with a
  `tanh` curve is zero-latency and probably the right call here given how much of
  this game is hit-stop and frame-accurate flashes.
- **`PannerNode` in HRTF mode is very expensive.** The play space is a plane —
  use `StereoPannerNode` or equal-power gain.
- **Autoplay policy:** since Chrome 71 an `AudioContext` starts `suspended` and
  there is **no muted-autoplay exception for Web Audio**. It must be resumed from
  a user gesture, and the definition of "user activation" is not uniformly
  applied to `keydown` across browsers. This game is played entirely on arrow
  keys and may never see a click. Verify keydown activation on the targets, or
  gate on a real click somewhere in the title screen.
- **Schedule against `ctx.currentTime`, never `performance.now()`,** with about
  15–25 ms of lookahead. Events scheduled in the past are applied immediately,
  which is where mysterious clicks come from.
- One aesthetic decision to make deliberately: **WebAudio's `square` and
  `sawtooth` are band-limited**, so they are cleaner than a POKEY or a 2A03,
  which alias audibly. That aliasing is part of what people hear as "chiptune".
  For a vector-arcade look rather than an 8-bit one, band-limited is probably
  correct — but it should be a choice, not a default.

---

## 6. A recommended palette for Kobayashi

Mapped onto the events that actually exist in `session.ts`, `docking.ts`,
`death.ts`, `hostiles.ts`, `mines.ts` and `weapons.ts`.

### The five principles this all rests on

1. **Drive parameters, do not fire clips.** Asteroids' whole sound interface is
   six write-only latches and the game keeps them current. Our audio module
   should expose an `update(dt, session, player)` that reads state — `threat`,
   `multiplier`, `energy`, `docking.phase`, `death.power` — far more than it
   should expose a `play("explosion")`. This is the audio version of "no DOM
   text": the sound is something the ship is producing, not something the game
   is playing at you.
2. **There is always a bed.** Battlezone's engine never stops. Ours is the
   reactor. It is one voice, it is below 500 Hz, and everything else sits on it.
3. **Static voice allocation, like a four-channel chip.** Asteroids and
   Battlezone assign sounds to fixed circuits and channels; nothing is pooled
   dynamically. Give each category a fixed bus and a hard voice count — bed 1,
   alert 1, phaser 3, torpedo/impact 3, hostile 4, mechanism 2, UI 2 — so a busy
   moment degrades predictably instead of turning to mud.
4. **Colour is information; so is band.** We already refuse decorative colours.
   Refuse decorative frequencies the same way. Reserve **below 120 Hz** for the
   alert pulse, torpedoes, mines and death. Phasers live **above 700 Hz** and may
   therefore be frequent. Nothing sustained sits in 2–5 kHz. **As built, this
   list is short two entries and the rule still holds against the actual code**:
   `breach` (`audio/sound.ts`) carries a 90 Hz tail on the roughest sound in the
   bank, and `hardDock`/`depart`/the Loom's own opening (`loomOpen`) were
   already sitting down there — a 600→70 Hz sweep, a 70→132 Hz sine, and a pair
   of 62/93 Hz sawtooths respectively — before this rule was ever checked
   against them. None of the four is decorative: each marks an event this
   principle would itself reserve the band for (a hull actually taking a hit,
   the clamps engaging, the ship shoving off them, a piece of machinery
   starting up), so the list was incomplete, not the rule wrong.
5. **Differentiate outcomes; never merely amplify.** The CHI 2024 result (§3) is
   unambiguous: variability and success-dependence drive enjoyment and playtime,
   and raw amplification *hurts* perceived competence. Every element should be
   answerable to "what does this tell the player that they could not otherwise
   know". If the answer is nothing, it belongs to the bed or it does not ship.
6. **When danger rises, duck the world — do not raise the alarm.** Alien:
   Isolation drives its whole mix from two continuous simulation values, and the
   move is to *lower* the ambience and *raise* the threat and the player's own
   ship. That is gain-staging of attention, and it costs no headroom.
7. **It should sound like it has just enough power to do its job.** Elite's audio
   lead had to write a fictional history of 34th-century displays to win this
   argument internally, but the rule that fell out is the right one for a machine
   that draws in phosphor behind CRT glass: **strain, not polish.** No clean
   modern UI design. The instrument is working hard.
8. **Silence is a cue.** See §6.10.

### 6.1 The bed

One reactor tone, two detuned oscillators about **0.4 Hz apart** so it breathes
without pulsing, fundamental near **58 Hz** with a couple of harmonics, through a
lowpass at 300–500 Hz with a **0.08 Hz** LFO on the cutoff. Present from the
moment a run starts.

Hook it to state that already exists:

- `player.energy` → cutoff and a slight pitch droop. A ship at 4% reserve should
  audibly sag. `Ship` already computes `starved = energy <= 0.02`; that is the
  point where the bed drops an octave-ish and a sparse relay tick appears.
- `player.thrust` → a second, brighter layer: filtered pink noise with cutoff
  following throttle, plus a small upward pitch bend on the fundamental.
  Battlezone's engine, one op-amp and a 555 in 1980, is a filter cutoff and a
  frequency `AudioParam` here.
- Turn rate → a very quiet gyro whine, high-passed, pitch following
  `angularVelocity`. Optional; test whether it reads as a ship or as a
  dentist's drill.

### 6.2 Phasers — the hard problem

Cooldown is **0.16 s**, so a held trigger fires at **6.25 Hz**. That rate is the
single nastiest mixing problem in the game: it is too fast to hear as discrete
events and too slow to fuse into a pitch, so a naive implementation lands
squarely in flutter and becomes a buzzsaw within seconds.

Seven things, in order of importance:

1. **Keep the whole sound shorter than the repeat period.** Asteroids' fire
   effect decays on a ~30 ms RC time constant. Target **≤ 110 ms total**, so two
   shots never overlap and level never accumulates. This is most of the fix and
   it is free.
2. **Alternate two pitches.** Steal `EOR #$14` directly. Alternate the base
   frequency between two values a fixed small interval apart (a minor third is a
   good starting guess). A repeat then reads as *a machine cycling* rather than
   as a stuck sample — and unlike random pitch jitter, it is deliberate and
   consistent, which is the difference between rhythm and noise.
3. **Encode the range rule.** `phaserDamageAt(distance)` already returns 0…0.34.
   Map it to lowpass cutoff and to the depth of the sweep, so a shot at 78 units
   that will do nothing sounds *thin and short* and a point-blank shot sounds
   full. This turns an invisible rule into an audible one, which is what this
   project does with everything else.
4. **Distinguish the three outcomes properly.** `Ordnance.discharge(from, to,
   hit)` already knows. A hit should not be a louder version of the miss — give
   it a separate, very short bright **return transient** arriving a few
   milliseconds later, as though something came back down the beam. A mine hit
   gets a third, duller return.
5. **On a sustained trigger, change the sound.** After the third consecutive shot
   inside a window, cross-fade into a **held** mode — a continuous filtered buzz
   at the fire rate with individual transients ducked, and a tail when the
   trigger releases. This is the standard three-stage automatic-weapon structure
   (ramp-up / loop / ramp-down) and it exists precisely because N discrete
   one-shots per second is not a solvable mixing problem.
6. **Band-limit hard.** Highpass everything phaser at 700 Hz. The reason phasers
   can be this frequent is that they never touch the bass, where the alert pulse
   and the torpedoes live.
7. **Cap at three voices and drop the fourth.** Never steal.

Worth naming plainly: **the canon we are drawing on has no documented answer to
this problem.** Asteroids limited the fire rate in hardware and gave the shot a
30 ms decay. Nobody in the twin-stick lineage has written down how they handled
projectile density. The only rigorous account anywhere is Returnal's — *"every
bullet was posting an event, which quickly became unmanageable. Instead,
projectiles are filtered and prioritized based on proximity and velocity"*, plus
voice limiting and a priority system in which higher-priority sounds duck lower
ones. Our version of that is small: rank the buses (Shroud return > hull breach >
torpedo impact > kill > phaser > hostile bolt), let the higher ones duck the
lower by a few dB for their duration, and prioritise projectile sounds by
proximity. Their thesis is the acceptance test — *"you need to hear everything
around you when you play, otherwise you're dead."*

Torpedoes are the opposite in every dimension, deliberately: cooldown 0.62 s,
twelve of them, huge damage. So they get the low end — a short launch thump with
a real sub component, a Doppler-ish falling pitch on the streak, and an impact
that triggers hit-stop. The **last torpedo** should sound different from the
other eleven, and firing on empty should produce a dry mechanical click rather
than silence: `player.torpedoes` is already checked, and a click is one modal
impulse.

### 6.3 The alert drone

Model: the Asteroids thump for the *shape*, Battlezone's missile buzz for the
*second tier*, Patterson for the *escalation policy*.

`Session.threat` already exists — the sum of hostile point values — and is
exactly the right driver.

- **A low pulse, constant length, shrinking gap.** Fixed ~70 ms on-time; gap
  interpolated from threat. Asteroids ran a duty cycle of roughly 8%–33%; ours
  should stay in that region, which means the alert is mostly silence even at
  maximum.
- **Two alternating pitches**, an interval apart, around 55–90 Hz.
- **Raise the pitch as well as the rate.** Asteroids only had rate (plus the
  two-note toggle). Alien: Isolation's motion tracker *"gets faster and faster
  and higher in pitch"*, and that is first-party. Two teams thirty-five years
  apart both reached for a heartbeat; only the later one used both axes. A
  fourth or so of total rise across the threat range is a starting guess.
- **Reset to slowest at each wave spawn.** Escalation you feel twice is worth
  more than a ratchet you stop noticing.
- **Escalate by adding, not by turning up.** Above a threat threshold, add a
  partial a low minor second above the fundamental — genuine critical-band
  roughness (§5), not a volume increase. Above a second threshold, add amplitude
  modulation at 30–45 Hz at low depth. Depth is the intensity control; volume
  never moves.
- **A second tier for immediate danger.** Battlezone gave the missile buzz its
  own voices. When something is actually within its `fireRange` and pointed at
  you, add a separate sparse element with a **different rhythm** — Patterson's
  finding is that rhythm distinguishes and timbre does not.
- **Patterson's decay.** If the threat level holds constant for more than ~8
  seconds, drop to a low-urgency form (lower, slower, quieter, ~4 s between
  bursts) and return to the urgent form only when threat *changes*. This is the
  single most important anti-fatigue measure and it is the one thing the
  Asteroids model lacks, because an Asteroids wave does not last ten minutes.
- **Off entirely** when `state === "clear"`, and during death. Non-negotiable.

A Shepard glissando is available for one specific job: the wave-escalation
moment, resolving to a single low sine at `SECTOR CLEAR`. Do not leave it
running.

### 6.4 Hostiles

Each class already owns a hue. Give each a **band and a rhythm**, not just a
timbre, because five of them will be on screen at once.

| Class | Colour | Sound identity |
|---|---|---|
| Raider (swarmer) | gold | fast, bright, thin — highest band, quickest bolt |
| Lance (sniper) | acid green | a charge before the shot; a rising, narrow, resonant tone that tells you it is lining up |
| Bastion (brawler) | red-orange | heavy and low; an audible mass, a slower and duller bolt |
| Harrow (miner) | violet | never fires — so it should be the one you hear *laying*: a mechanical release, then the mine's own arming tick |
| Shroud (stalker) | magenta | see below |

Mines deserve their own note because they are the one hazard that is dangerous
without being alive. `MINE.arm` is 1.3 s; give the arming a single soft click at
the end of it, and give an armed mine a very quiet periodic tick that gets
faster with proximity — `mines.ts` already computes `near` for the draw. That
converts the minefield from a visual hazard into a spatial one, which is what
mines are for. Chain detonations already stagger by `chainFuse`; let the audio
inherit that stagger rather than summing into one bang.

### 6.5 The Shroud, and telegraphing what cannot be seen

This is the fairness problem, and the model is not a game at all — it is the
scanner we already built.

The scanner paints a cloaked hull only when the arm crosses it, with a real
positional error drawn as the circle it actually is, decaying over three
seconds; three returns with tightening rings is a Shroud closing. The audio job
is to make that legible without looking at the tube.

- **Give the sweep a return.** A short ping when the arm paints an unresolved
  contact, panned by bearing.
- **Make the uncertainty audible as roughness.** Two oscillators detuned in
  proportion to the positional error, so a wide error ring is a rough, beating,
  ambiguous ping and a tight one **resolves toward a clean tone**. The player
  learns "it is getting cleaner" without being told anything. This is the
  radio-range trick (§6.6) applied to a threat instead of a course, and it is
  honest: the sound encodes the same uncertainty the circle does.
- **Then the materialise.** `Hostile.reveal` runs over `wind = 0.45 s` and the
  session already says `DECLOAKING`. That gets a rising inharmonic swell — FM
  with a non-integer ratio, index climbing — that **resolves into the Shroud's
  own timbre at exactly the moment it can fire**. The tell must complete before
  the first bolt, not with it.
- **It must survive a held trigger.** Put the ping in a band nothing else uses
  and duck the phaser bus by a few dB for its duration. Patterson's four-spread-
  components rule exists for exactly this reason.

### 6.6 Docking

The most elaborate thing in the game and currently silent. It has five stages
with known timings, which means it can be scored almost like a cue.

**Approach (`aligning`, guidance visible inside 62 units).** The precedent here
is real and public-domain: the **low-frequency four-course radio range**, the
1930s A-N beam. Off course to one side you heard an interlocking Morse "A"
(di-dah); to the other, "N" (dah-dit); **on course the two interlocked into a
single steady tone.** Pilots flew instrument approaches by ear for forty years on
this. It is exactly the shape of `DockGuidance`, it is an instrument rather than
a game sound, and nobody owns it.

Concretely: two short pulses, one panned left and one right, whose relative
timing and level are driven by `guidance.lateral`. Off centre they read as two
interleaved rhythms; centred they interlock and go beat-free. Layer the two
independent gates on top as separate conditions — `speedOk` and `headingOk` each
suppress a small nagging element, so satisfying a condition is heard as
*something stopping*, which is a far better reward than something starting.

**Capture (`TRACTOR LOCK`, 1.35 s).** A rising tone whose curve follows the
`easeInOut` already used for the position lerp, so the ear and the eye agree.
Make it filtered noise plus a pitch ramp rather than a pure sweep — a pure rising
sine is the most clichéd sound in the medium. The tractor draw already has a
`sin(time * 14)` pulse in the visuals; use the same rate for an amplitude
modulation so the beam looks and sounds like one thing.

Elite's frame-shift charge is the precedent worth copying here and it makes one
specific move: it **builds in spectral width and depth rather than in level.**
Start narrow — one band, tight Q — and open outward, adding partials and widening
the stereo image, while the gain barely moves. That is what "something enormous
is taking hold of you" sounds like, and it does not eat headroom you will need
for the clunk that follows. The same technique is waiting for hyperwarp when the
chart lands.

**Hard dock.** The clunk, and the payoff for §5's modal section. Two contacts,
**30 ms apart**: a metallic latch (bar ratios, f0 ~1.4 kHz, T60 ~350 ms) then a
dull seat (membrane ratios, f0 ~120 Hz, T60 ~90 ms, plus a 60 Hz sine for mass).
Then — and this is the important part — **a beat of near-silence** before service
starts. `docking.ts` fires `onMoored()` here; the status line changes; nothing
else needs to happen for a quarter of a second.

**Service (four stages at 0.55 / 1.05 / 1.65 / 2.05 s).** Four ascending blips,
but give each a *different resonator* as well as a different pitch, so they are
different materials and not just a scale: shields a bright ringing charge, hull
a duller repeated tap, reactor transfer a low surge with the bed audibly
strengthening under it, rearming a mechanical rack sound with as many small
impulses as torpedoes were loaded. Each announcement in `updateService` is
already a one-shot edge — that is the trigger.

**The tally.** `bank()` freezes `{ salvage, multiplier, total }` and the odometer
rolls `displayScore` toward `score`. Two elements:

- The **odometer tick**, quantised to a fixed grid so it is a rhythm rather than
  a rattle, with the rate proportional to the remaining distance so it slows as
  it lands — which is what the easing already does visually.
- The **arpeggio, pitched by multiplier**. The nearest precedent is Peggle, whose
  peg hits play ascending scales that stay in the key of the current music
  segment, with a second instrument layered in for the pegs that matter. Ours is
  simpler because we have no music: pick one scale and stay in it forever, so it
  can never sound wrong. Multiplier runs 1.0–9.9. Map it to **both the number of
  notes and the register**: something like `notes = 3 + round((m - 1) × 0.7)`,
  transposed up a fixed interval per whole multiplier point, with the final note
  held. Banking 9.9× should be a genuinely longer and higher figure than banking
  1.2×, so the greed loop has a sound and not just a number. Layer the second
  instrument in above a threshold, the way Peggle marks an orange peg.

  **Be clear about the pedigree here, because it is thinner than it looks.**
  Peggle establishes *score-as-music* — an escalating musical figure tied to a
  reward — and that much is solid. But I found **no source at any quality level**
  documenting a music-to-multiplier or music-to-score coupling in any Geometry
  Wars title, or anywhere else in the arcade or twin-stick canon. Pitching the
  tally by the multiplier specifically is **our idea**, not an inherited one. It
  may well be a good idea — it is the most direct possible expression of the one
  decision the whole game is built on — but nothing in this document proves it
  works, and it should be treated as the most speculative recommendation here.

**Departure.** `depart()` shoves you off the clamps at 14 units/s. Release the
clamps (a short mechanical unlatch, the hard-dock sound reversed in structure —
dull first, metallic second), then the bed comes back up as thrust returns.

### 6.7 Damage

- **Shield absorb.** `takeHit` routes to one of four facings. Pan and pitch the
  absorb by facing, so you hear *which quarter* took it — a facing you cannot see
  is exactly the case where audio earns its place. Depleting shield → the sound
  gets thinner and more of the impact transient comes through, so a dying facing
  is audible before it fails.
- **Hull breach.** `breach()` halves the multiplier, which is the real cost.
  Give it the roughest sound in the game — this is the one place for 70 Hz
  amplitude modulation at high depth, for under half a second. Then a distinct
  descending figure for the multiplier halving, because the number on the HUD is
  the thing the player actually lost and it deserves its own cue.
- **Hit-stop.** `Session.timeScale` dips on impact, kill, breach and death. Mark
  it on the **beds only** — a brief lowpass and pitch dip on the bed and alert —
  and never on the transient that caused it, which must stay sharp. Note the
  existing discipline: hit-stop drains on wall-clock seconds, so the audio dip
  must too.

### 6.8 Death

`death.ts` gives exact timings, and they are already scored:

- **0 → 0.55 s, breakup.** The biggest explosion in the game, built long: full
  four-layer stack, centroid falling 5 kHz → 120 Hz over about two seconds, sub
  present, tail present. Simultaneously, **`power` is the mix**. It runs 1 → 0
  with a deliberate flicker (`sin(time * 61) > 0.1 ? 1 : 0.2`) after t > 0.45.
  Drive the bed's cutoff and pitch *and* the master gain of every instrument
  voice from `power`, so the ship's audio dies on exactly the same curve as its
  panel. A supply failing, not a switch thrown.
- **0 → 0.95 s, the shock ring.** A single low sweep running outward, its
  centroid falling as the ring expands. Same curve as the visual.
- **0.55 → 3.0 s, drift.** This is where silence does the work, and it is the
  precedent Asteroids hands us directly: the thump is **cut** while the ship
  explodes. Almost nothing here — debris tails burning down, a very low sub, and
  the one scripted blip at 1.15–1.24 s when `power` briefly hits 0.3, which
  should be a single small relay tick and nothing more. Two and a half seconds of
  near-silence after the loudest event in the game is the most powerful thing in
  this document and it costs nothing to build.
- **3.0 s onward, tally.** Emergency power spools the panel back up over 0.5 s —
  a rising hum with the bed reassembling — then the epitaph. Use the **same
  arpeggio figure as the docking tally**, but lowered, slower, and one note
  short. `lastRun.lost` is what the run was worth one dock short of home; that
  number is the sting, and the figure that plays under it should be the banking
  figure that did not happen.

### 6.9 The multiplier as a through-line, and the scanner as a second ear

Two structural recommendations that are not tied to a single event.

**Make the whole run point at the dock.** Elite's audio lead: *"When comparable
activities are undertaken, those are accompanied by similar sound signatures…
**Repeating audio during progression of a game-loop constantly hints towards the
pay-off much later.**"* Their case was explorers scanning data for months before
selling it. Ours is the multiplier — earned continuously, realised only on
docking, lost entirely if you die. So the kill that raises the multiplier, the
multiplier readout on the HUD, the salvage-transfer stage of the docking sequence
and the tally arpeggio should be **one family of sound in four registers**, so
that every kill is audibly a deposit against a payout that has not happened yet
and that you can still lose. That is the greed loop expressed as timbre, and it
is free once the family exists.

**Give the scanner its own listening position.** Duskers gives the player two:
the schematic view hears the hull globally, the drone view hears locally. We have
the same split permanently on screen — forward view and overhead scanner, which
is the 1982 cabinet's contribution and half our interface. The scanner should
therefore sound like a *different instrument*, not like a quieter mix of the
forward view: sweep, return, a noise floor of its own. Everything in §6.5 hangs
off this.

And a warning aimed squarely at the roadmap. **NEBULOUS: Fleet Command models
combat audio in world space with steep falloff, and because the camera normally
sits in tactical view, players hear almost nothing** — one called it "a space
battle from a silent movie". Honest distance modelling that became uninformative.
When the chart arrives in weeks 6–8 it will be a map view raisable mid-fight, and
if raising it quietly moves the ear away from the battle we will have rebuilt
that failure exactly. The chart must have its own voice, the way the scanner
does.

### 6.10 Silence, deliberately

Verified from the Asteroids source: the thump is silenced when there are no
asteroids left, when the ship is exploding, and when the ship is not on screen.
**The two loudest moments in that game are its two quietest.** That is not an
accident of the hardware; it is three explicit branches in the code.

Ours, then:

- **`SECTOR CLEAR` → the 2.6 s `WAVE_BREAK`.** Alert off entirely. Bed only. This
  is the only rest the player gets and it should be audible as a rest.
- **The death drift**, as above.
- **The beat after `HARD DOCK`** before service begins.
- **The title screen before the first keypress.** The autoplay policy forces this
  on us — the context cannot resume until a gesture — and it is worth
  reframing as authentic rather than as a limitation. A cabinet you have not
  walked up to is a cabinet you cannot hear. Attract mode gets sound only after
  the first run, which is exactly how a real one behaves once someone has been
  standing at it.

---

## 7. Open questions — the ones only a human at the keyboard can settle

Same status as the flight-model constants in [status.md](./status.md) §7: these
are not researchable, they are playable.

1. **Does the alert drone read as pacing or as nagging over ten minutes?**
   Asteroids' evidence is from three-minute sessions. Patterson's decay-to-
   low-urgency policy is the proposed answer, but the thresholds and the eight-
   second hold are guesses.
2. **Should the alert's tempo track `threat` (total point value on the board) or
   the range of the nearest hostile?** Threat is what we already compute and is
   the honest measure of the situation; range is what the body actually cares
   about. It may need to be both, on different elements.
3. **Discrete shots or a held buzz?** The three-stage automatic-weapon structure
   is the standard answer for 6.25 Hz fire, but it may make phasers feel like a
   different weapon than they are. Worth building both behind a toggle, the way
   `G` toggles wireframe.
4. **Is the two-pitch alternation enough, or does the phaser need a third
   variant?** Asteroids only needed two, but its fire rate was slower.
5. **Does the docking guidance tone help or become the sound you learn to
   ignore?** The A-N range worked because pilots had no alternative; our player
   has a perfectly good visual instrument sitting right there.
6. **How loud is the tally relative to combat?** Waves keep arriving while you
   are moored. The tally is the payoff for the entire greed loop and it is
   competing with an active fight.
7. **Do five hostile timbres survive five simultaneous hostiles?** The voice
   budget says they should degrade predictably. Whether they remain *legible* is
   an ear question.
8. **Should hit-stop bend the beds, or is that seasickness?**
9. **Does two and a half seconds of near-silence in the death sequence read as
   gravity, or as a crash?** On a laptop speaker, with a stranger playing, this
   is the riskiest recommendation in this document.
10. **Is a formant-synthesis voice worth building at all?** Star Wars proves
    obviously-synthetic speech is effective and legitimate. It is also the single
    largest piece of work here, and "DECLOAKING" spoken badly is worse than
    "DECLOAKING" drawn well. Elite's argument for adding speech is that *"beeps
    and alarms can only tell you so much"* — but they were also *"very wary of
    spamming the player."*
11. **Does the multiplier through-line (§6.9) actually read as one family, or
    just as four unrelated sounds?** This is the most conceptually ambitious
    recommendation in the document and the one most likely to be heard as nothing
    at all.
12. **Does ducking the world beat raising the alert?** Alien: Isolation's answer
    is unambiguous, but their world is an ambience and ours is a combat mix that
    the player also needs. Ducking the phaser bus to let a Shroud return through
    may read as the gun malfunctioning.
13. **Does the two-pitch alternation still work when a pitch *ramp* is layered on
    top?** §6.3 recommends both Asteroids' toggle and Isolation's rising pitch.
    Nobody has shipped both at once as far as I can tell, and they may fight.
14. **How much of this should exist at all?** The CHI 2024 result says
    differentiation earns its place and amplification costs us. The honest
    conclusion is that the *minimum* useful build — bed, alert, phaser, kill,
    breach, dock clunk, tally — may be better than the full palette, and that the
    full palette should be added one element at a time with someone listening.

---

## Sources

**Vector arcade hardware and code**

- [Asteroids — Wikipedia](https://en.wikipedia.org/wiki/Asteroids_(video_game)) (sound circuits by Wendi Allen / Howard Delman; 13 effects; no sound chip — cited there to *Retro Gamer* 68 and to *Atari Inc.: Business Is Fun*)
- [Asteroids disassembly — nmikstas](https://github.com/nmikstas/asteroids-disassembly/blob/master/AsteroidsSource/asteroids_program_rom.asm) and [asteroids_defines.asm](https://github.com/nmikstas/asteroids-disassembly/blob/master/AsteroidsSource/asteroids_defines.asm) — the thump routine at `L7580`–`L75BC`, the speed-up at `L6960`, the wave reset at `L71DA`, and the sound register map
- [Computer Archaeology: Asteroids](https://computerarcheology.com/Arcade/Asteroids/) · [6502disassembly.com Asteroids](https://6502disassembly.com/va-asteroids/Asteroids.html)
- [Museum of the Game forums: "Asteroids sounds, or how do 555 set-ups differ?"](https://forums.arcade-museum.com/threads/asteroids-sounds-or-how-do-555-set-ups-differ.181733/) — the 555 / 4016 / LM324 topology and the ~0.03 s fire decay. Forum-sourced; treat as informed hobbyist consensus, not documentation
- [MAME PR #6979 — netlist audio for early Cinematronics vector games](https://github.com/mamedev/mame/pull/6979)
- [Battlezone (1980) disassembly](https://6502disassembly.com/va-battlezone/) — POKEY channel allocation and the discrete engine/cannon/explosion circuits
- [Battlezone — Wikipedia](https://en.wikipedia.org/wiki/Battlezone_(1980_video_game))
- [Tempest: detailed theory of operation — Nick Sayer](https://www.kfu.com/~nsayer/games/tempest.html) — two POKEYs, mixing at K6, tones doubled across both chips
- [Tempest — Wikipedia](https://en.wikipedia.org/wiki/Tempest_(video_game))
- [POKEY — Wikipedia](https://en.wikipedia.org/wiki/POKEY) — channels, dividers, the 4/5/17-bit polynomial counters, 16-bit pairing, high-pass filters
- [Star Wars (1983) — Wikipedia](https://en.wikipedia.org/wiki/Star_Wars_(1983_video_game)) · [The Audio of Star Wars (1983)](https://philreichert.org/read/0044.html) · [arcade-history](https://www.arcade-history.com/?page=detail&id=2623) — 68B09E, 16 KB ROM, four POKEYs, TMS5220, stereo image synthesiser
- [Major Havoc — arcade-history](https://www.arcade-history.com/?n=major-havoc&page=detail&id=1543) (four POKEYs) · [Lunar Lander — arcade-history](https://www.arcade-history.com/game/1417/lunar-lander) · [Red Baron — Wikipedia](https://en.wikipedia.org/wiki/Red_Baron_(1980_video_game))
- [Space Invaders / Nishikado — Wikipedia](https://en.wikipedia.org/wiki/Tomohiro_Nishikado) — the four descending notes and the emergent acceleration

**Synthesis technique**

- [sfxr — DrPetter](https://www.drpetter.se/project_sfxr.html) · [sfxr source, `main.cpp`](https://github.com/grimfang4/sfxr/blob/master/sfxr/source/main.cpp) · [jsfxr](https://github.com/chr15m/jsfxr) · [Bfxr](https://www.bfxr.net/) · [LMMS sfxr manual](https://docs.lmms.io/user-manual/en-stable/instruments/sfxr)
- [Chowning, *The Synthesis of Complex Audio Spectra by Means of Frequency Modulation*, JAES 21(7), 1973 (PDF)](https://web.eecs.umich.edu/~fessler/course/100/misc/chowning-73-tso.pdf)
- [Farnell, *Designing Sound* (MIT Press)](https://mitpress.mit.edu/9780262014410/designing-sound/) · [*Designing Sound in SuperCollider* wikibook](https://en.wikibooks.org/wiki/Designing_Sound_in_SuperCollider/Print_version)
- [CCRMA: percussion and modal ratios](https://ccrma.stanford.edu/CCRMA/Courses/152/percussion.html) · [BYU acoustics: free–free bar modes](https://acoustics.byu.edu/animations-bar-trans-free-free)
- [Noise generation in WebAudio](https://noisehack.com/generate-noise-web-audio-api/) · [Kellet's pink noise filters](https://www.firstpr.com.au/dsp/pink-noise/)

**Psychoacoustics and warning design**

- [Arnal et al., *Human Screams Occupy a Privileged Niche in the Communication Soundscape*, Current Biology 25(15), 2015](https://www.cell.com/current-biology/fulltext/S0960-9822(15)00737-X) · [NYU summary](https://www.nyu.edu/about/news-publications/news/2015/july/researchers-find-the-acoustic-signature-of-screams.html) · [Arnal et al. 2019, Nature Communications (open access)](https://pmc.ncbi.nlm.nih.gov/articles/PMC6694125/) — aversion peaks at 40 Hz
- [Plomp & Levelt, *Tonal Consonance and Critical Bandwidth*, JASA 38(4), 1965 (PDF)](https://www.mpi.nl/world/materials/publications/levelt/Plomp_Levelt_Tonal_1965.pdf)
- [Patterson, *Auditory warning sounds in the work environment*, Phil. Trans. R. Soc. Lond. B 327, 1990 (PDF)](https://www.pdn.cam.ac.uk/system/files/documents/AuditoryWarningsAtWork_RSoc1990.pdf) — the free counterpart to CAA Paper 82017 (1982)
- [FAA Human Factors Design Standard, Ch. 7: Alarms, audio and voice (PDF)](https://hf.tc.faa.gov/hfds/download-hfds/hfds_pdfs/Ch7_Alarms_audio_and_voice.pdf)
- [Roughness and fluctuation strength — Salford acoustics](https://acoustics.salford.ac.uk/psychoacoustics/sound-quality-making-products-sound-better/an-introduction-to-sound-quality-testing/roughness-fluctuation-strength/)
- [Shepard tone construction — Audiolabs Erlangen](https://www.audiolabs-erlangen.de/resources/MIR/FMP/C1/C1S1_ChromaShepard.html)

**Modern descendants**

- [Oral history of *Rez* — Game Developer](https://www.gamedeveloper.com/audio/oral-history-of-i-rez-i-recounts-a-marriage-of-game-and-music) (Mizuguchi at GDC 2016 on quantisation) · [The making of Rez — Time Extension](https://www.timeextension.com/features/the-making-of-rez-tetsuya-mizuguchis-timeless-masterpiece) · [Area 5 deconstructed — PlayStation Blog](https://blog.playstation.com/archive/2017/10/20/classic-levels-deconstructed-tetsuya-mizuguchi-musician-adam-freeland-dissect-rez-infinites-area-5) · [Hydelic on Tetris Effect — Splice](https://splice.com/blog/hydelic-q-and-a/)
- [Seven Years in Alpha: the Thumper postmortem — GDC Vault](https://gdcvault.com/play/1024291/Seven-Years-in-Alpha-Thumper) · [writeup — Thumbsticks](https://www.thumbsticks.com/gdc-17-how-thumper-turned-into-something-special/) · [Road to the IGF: Drool's Thumper — Game Developer](https://www.gamedeveloper.com/audio/road-to-the-igf-drool-s-i-thumper-i-) · [The helpful, harmful sounds of Thumper — SUPERJUMP](https://www.superjumpmagazine.com/the-helpful-harmful-sounds-of-thumper/) · [Kotaku](https://kotaku.com/thumper-is-the-best-kind-of-music-game-1787670750)
- [The colour and the shape: Bizarre Creations on GeoWars — Gamasutra/Game Developer](https://www.gamedeveloper.com/game-platforms/the-color-and-the-shape-bizarre-creations-on-i-geowars-i-sensible-aesthetic) — the per-enemy spawn-sound finding
- [The Game Is The Boss: a Resogun postmortem — Game Developer](https://www.gamedeveloper.com/business/the-game-is-the-boss-a-i-resogun-i-postmortem) (notable for containing no audio content) · [Resogun review — GamesBeat](https://gamesbeat.com/resogun-review/) · [Game design deep dive: maintaining tension in Nex Machina — Game Developer](https://www.gamedeveloper.com/design/game-design-deep-dive-maintaining-tension-in-i-nex-machina-i-)
- [Space Giraffe — Wikipedia](https://en.wikipedia.org/wiki/Space_Giraffe) · [Q&A with Jeff Minter — SPOnG](https://spong.com/feature/10109564/Q-A-Space-Giraffe-Creator-Jeff-Minter-Part-2) · [Akka Arrh interview — PlayStation Blog](https://blog.playstation.com/2023/02/17/jeff-minter-interview-the-legendary-game-designer-on-his-upcoming-ps4-ps5-arcade-title-akka-arrh/) · [Polybius PC manual — Minter's own blog](http://minotaurproject.co.uk/blog/?p=484)
- [The audio of Returnal — A Sound Effect](https://www.asoundeffect.com/returnal-game-audio/) — projectile filtering, voice limiting, priority ducking
- [Kao, Ballou, Gerling, Breitsohl & Deterding, *How does Juicy Game Feedback Motivate?*, CHI 2024](https://dl.acm.org/doi/10.1145/3613904.3642656) · [PDF](https://people.csail.mit.edu/dkao/pdf/3613904.3642656.pdf) · [Smets & van der Spek, *That Sound's Juicy!*, 2021](https://link.springer.com/chapter/10.1007/978-3-030-89394-1_24)

**Diegetic instruments**

- [Ben Prunty AMA on the FTL two-track system](https://www.reddit.com/r/gamemusic/comments/23vu1v/ama_im_ben_prunty_i_made_the_music_for_ftl_and/) · [Interview — Cheerful Ghost](https://cheerfulghost.com/jdodson/posts/1552/interview-with-ftl-composer-ben-prunty) · [What I used to make the FTL soundtrack](https://benprunty.com/2013/01/03/heres-what-i-used-to-make-the-ftl-soundtrack/) · [FTL sound modding — Subset forum](https://subsetgames.com/forum/viewtopic.php?t=3044)
- [Tim Keenan, "The front door" — Misfits Attic blog](https://misfitsattic.blogspot.com/2024/09/the-front-door.html) · [2017 IGF interview — NYU Game Center](https://gamecenter.nyu.edu/2017-igf-interviews-duskers/) · [When the player's screen is the game's screen — Game Developer](https://www.gamedeveloper.com/design/when-the-player-s-screen-is-the-game-s-screen) · [Duskers update #13 patch notes](https://steamcommunity.com/app/254320/discussions/0/412448792348981743)
- [The audio of Alien: Isolation — PC Gamer](https://www.pcgamer.com/the-audio-of-alien-isolation/) · [Byron Bullock — BBC](https://www.bbc.com/news/technology-29516760) · [Byron Bullock — The Sound Architect](https://www.thesoundarchitect.co.uk/alienisolation/) · [The sound of Alien: Isolation — Audio Media International](https://www.audiomediainternational.com/feature/the-sound-of-alien-isolation) · [Revisiting the AI of Alien: Isolation — Game Developer](https://www.gamedeveloper.com/design/revisiting-the-ai-of-alien-isolation) · [The perfect organism: the AI of Alien: Isolation](https://www.gamedeveloper.com/design/the-perfect-organism-the-ai-of-alien-isolation) · [Jaroslav Švelch, *Game Studies*](https://gamestudies.org/2002/articles/jaroslav_svelch)
- [Meet the team: Matthew Florianz — Frontier](https://community.elitedangerous.com/en/node/274) · [Meet the team: Joe Hogan](https://community.elitedangerous.com/en/node/299) · [Florianz's own Elite project page](https://www.matthewflorianz.com/audio/matthewflorianz_projects_elitedangerous.html) · [Florianz, *Sound in Space*, Control Conference 2015](https://www.youtube.com/watch?v=GiAcsrmyePs)
- [NEBULOUS gamerip track listing](https://downloads.khinsider.com/game-soundtracks/album/nebulous-fleet-command-windows-gamerip-2021) · [Lauren Pham, NEBULOUS OST](https://laurenpham.bandcamp.com/album/nebulous-fleet-command-original-soundtrack-vol-1)

**Game audio practice**

- [Scoring Peggle Blast — Audiokinetic / G.A.N.G.](https://www.audiogang.org/scoring-peggle-blast-new-dog-old-tricks/) · [Peggle 2: Sonic Joy!](https://www.audiogang.org/peggle2-sonic-joy/)
- [How to maintain immersion and reduce repetition in game audio — A Sound Effect](https://www.asoundeffect.com/game-audio-immersion/) (also the source for Bjørn Jacobsen's in-tune/out-of-tune test)
- [Designing weapon sound for video games — Splice](https://splice.com/blog/design-weapon-sound-video-games/)
- [Enemy attacks and telegraphing — Game Developer](https://www.gamedeveloper.com/design/enemy-attacks-and-telegraphing)
- [Silence in sound design — gamesounddesign.com](https://gamesounddesign.com/Silence-In-Sound-Design.html)

**Instrument precedents**

- [Low-frequency (four-course) radio range — Wikipedia](https://en.wikipedia.org/wiki/Low-frequency_radio_range) · [Flying the Beams](https://flyingthebeams.com/extra-1)

**WebAudio**

- [Web Audio API spec](https://www.w3.org/TR/webaudio-1.1/) · [MDN: AudioBufferSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode) · [MDN: exponentialRampToValueAtTime](https://developer.mozilla.org/en-US/docs/Web/API/AudioParam/exponentialRampToValueAtTime)
- [Paul Adenot, Web Audio performance notes](https://padenot.github.io/web-audio-perf/) · [Ramping to value without clicks](http://alemangui.github.io/ramp-to-value) · [Chrome autoplay policy](https://developer.chrome.com/blog/autoplay/)

---

## What could not be verified

Recorded here because passing on folklore is how this subject got into its
current state.

- **The Asteroids tick rate.** The thump's on-time of 4 and off-reload of 48→8
  are from the source. That those are 60 Hz frames is my inference; it matches
  recordings but I did not confirm it from the schematic, so the derived
  0.87 s → 0.20 s figures carry that assumption.
- **"The Asteroids heartbeat speeds up as you destroy asteroids."** This is the
  most repeated claim about the game's audio and the code does not support it —
  the speed-up is on a frame counter and resets at wave init. I am confident in
  the reading but it is a disassembly by a third party, not Atari's source.
- **"The Asteroids heartbeat was inspired by *Jaws*."** Very widely repeated. I
  could not find it in any interview with Delman/Allen or Logg. Delman's actual
  quoted account is about a heartbeat and about the player's pulse rising, with
  no film mentioned. Do not repeat the *Jaws* version.
- **The ~0.03 s RC time constant on the Asteroids fire circuit** comes from a
  forum post reading the schematic, not from Atari documentation.
- **Tempest's sound design.** I verified the hardware and nothing else. There is
  no per-effect breakdown I could find, and the frequently-made claim that its
  audio "reinforces the depth of the tube" appears to be an observation rather
  than a documented decision. Nothing in §6 depends on it.
- **Star Wars' speech vocabulary size** and how the 16 KB was split between
  program, sound tables and speech. Only the total is documented.
- **Chowning's brass figures** (1:1, index 0→5). Widely cited; the bell, drum and
  wood-drum numbers are confirmed against multiple course notes, the brass one is
  not.
- **IEC 60601-1-8's actual parameter table** — pulse durations, rise/fall times,
  pulses per burst by priority. Every freely available summary paraphrases the
  standard rather than quoting it. The commonly repeated figures (75–200 ms
  pulses, 5/3/1 pulses per burst) should be treated as unverified. Patterson is
  the better guide anyway, and his numbers *are* checkable.
- **"Consecutive stomps in Super Mario Bros. rise in pitch."** True by ear, and a
  standard example of score-as-music, but I found no primary source and have not
  used it as evidence for anything here.

### The modern half, which is much worse

The neon/twin-stick corner has no GDC audio talk, no trade-press audio feature
and no composer interview for **any** of Geometry Wars, Resogun or Nex Machina.
Almost everything commonly said about their audio is unsourced.

**Do not cite at all, in any form:**

- **Polybius' "beat-synced shaders."** Traces to Grokipedia, which is
  AI-generated. Minter's own manual for the game mentions audio zero times.
- **Rez's "every beat, synth note and clip is an individual file assembled in
  real time."** Same origin; the forum thread it appears to cite never mentions
  Rez.
- **"Christian Kjeldsen" as an Alien: Isolation composer.** The name does not
  appear in any credit; it is almost certainly a conflation with Christian
  Henson.

**No source of any quality exists for:**

- Any **music-to-multiplier or music-to-score coupling in any Geometry Wars
  title**. This matters to us specifically: it means §6.6's multiplier-pitched
  tally has no arcade pedigree and is our own invention.
- Voice limiting, culling or pitch randomisation in Geometry Wars, Resogun or
  Nex Machina; how Resogun's audio handles voxel destruction.
- Whether Duskers' degraded sound is real-time DSP or baked into assets, and who
  did its sound design at all.
- NEBULOUS' contact-acquired / track-lost / jamming cues, and its music state
  machine — the horizontal-resequencing reading in §4 is inferred from asset
  filenames, not stated by anyone.
- Whether Rez's *hit registration*, as opposed to its audio, is quantised.
- Whether Alien: Isolation's tracker ping is spatialised for the player or is a
  near-field 2D source.
- Tempest 4000's music credits.

**Single-source or weak-source, flagged where used:** the Rez lock-on
"quantised to the scale" detail (one forum post); Bjørn Jacobsen's in-tune test
(n = 19, informal, self-reported quit time); the Alien tracker's "sub-one-second
raise makes no sound" trick (Steam and GameFAQs folklore); Duskers' enemy-sound
taxonomy (players reverse-engineering, not the developer). Two sources disagree
on Rez's sound director — Wikipedia says Keiichi Sugiyama, Time Extension says
Nobuhiko Tanuma.

**Assertions of a negative**, which are inherently weaker than the rest: that
Tempest 2000/TxK/Tempest 4000 have no reactive audio system; that Resogun has no
documented adaptive audio architecture. Both mean "I could not find one", not
"one does not exist".

### A note on method

One source encountered during this research — The Cutting Room Floor's page on
FTL — carried an **embedded prompt-injection attempt aimed at automated agents**,
framed as instructions "for agents, not humans" and requesting destructive file
operations. It was refused and not used. Nothing in this document is sourced to
it, and anything anyone later finds attributed to TCRF should be independently
verified before it goes anywhere near a decision.

---

## 8. Addendum: material recovered after the document was written

A fourth research pass returned after this document was assembled, and one of
its findings reframes §6.2 — the phaser problem — rather than merely adding to
it. Recorded here rather than folded in, so the provenance stays honest.

### Rez's answer to rapid fire is the input grammar, not the mixer

§6.2 concluded that the canon has no documented answer to a weapon firing every
0.16 s, and that only *Returnal* solves it, by filtering projectile events on
proximity and velocity. That stands. But *Rez* sidesteps the problem entirely,
and the mechanism is worth knowing before we spend effort mixing our way out of
it.

**Rez has no machine-gun input.** You hold fire to paint up to eight targets,
then release a volley. Eight lock-ons arrive as one rhythmic figure spread
across subdivisions — not as eight copies of a sample fighting each other. The
game contains almost no non-musical SFX at all.

On top of that sits the quantisation, which is primary-sourced to Mizuguchi's
GDC 2016 talk: *"The magic that happened is quantization. Even if a player
wasn't great at matching their interactions with the beat, quantization would
synch the rhythms of play and make you feel good."* And: *"Shooting gives you
sounds; it's like a call and response."*

*The implication for us, stated plainly:* our phaser's fatigue problem may be a
**weapon-cadence problem wearing an audio costume**. `PHASER` fires on a 0.16 s
cooldown, and every documented solution in the literature either changes what
the trigger does (Rez), filters which events are allowed to speak (Returnal), or
accepts the sound is decorative (Geometry Wars' music, by its own designer's
admission). Mixing is the only one of those we have tried. Worth putting on the
tuning list as a design question, not just a mix one — with the caveat that
`PHASER` cadence is a locked-feeling combat constant and this document has no
business quietly relitigating it.

*Unresolved:* sources disagree on whether Rez quantises only the audio or the
projectile and hit timing too. Wikipedia says impacts "automatically syncs with
the background track"; no developer statement settles it.

### Thumper: the cue arrives before the input

Each obstacle type has a distinct call-out tone that *"gives the player a few
vital sub-seconds to prepare for the succession of button presses ahead"* —
audio acting as a substitute HUD against a visually saturated screen.

This is the same principle as §6.5's Shroud telegraph, arrived at independently,
and it generalises: on a screen this busy, an audio cue that *precedes* the
event it describes is doing work no visual can do, because the player's eyes are
already committed elsewhere.

Thumper also turns its own audio against the player — a hit replaces the
percussion with *"the grating sound of machinery gone wrong"*, and late levels
become deliberately **less** musical. Its level editor is a music sequencer: the
level and the score are one authored object.

The distinction its designers draw is useful. *Rez* lets you improvise; *Thumper*
makes you perform a fixed part. A game where waves escalate on a clock is
structurally closer to Thumper than to Rez.

### Two more empirical results, both supporting §3's governing finding

- **Smets & van der Spek (2021)**, n = 61 between-subjects: "juicy" audio
  treatment produced a significant **medium-effect** gain in presence. Notably
  **stronger than the equivalent visual result** — Hicks et al. (CHI PLAY 2019)
  found visual embellishment improves visual appeal but affects competence only
  in specific circumstances. Audio polish appears to buy more than visual polish
  does, per unit of effort.
- **Kao et al. (CHI 2024)**, restated with the detail that matters most: it is
  **success dependence** — feedback that fires on *succeeding* rather than on
  merely pressing — that "enhanced all motives", while amplification alone
  "negatively impacted effectance and competence". Our phaser currently speaks
  on every trigger pull, with a separate spark on a hit. That is the correct
  shape; the risk is that the trigger sound is loud enough to bury the spark,
  which would invert the finding.

### One number for §4's motion-tracker discussion

Alien: Isolation's motion tracker emits noise the creature can hear at
**~1.5 m**. §4 established the rule qualitatively ("a very short radius"); this
is the figure, from the same reverse-engineering of shipped behaviour-tree data.

### Provenance and a process note

All of the above comes from a research pass whose own three sub-agents failed to
report back to it, and which then exhausted the session's web-search budget. Its
coverage is uneven by its own account, and it flagged several claims it could
not verify: Tempest 4000's music credits, whether *Polybius* has reactive audio
at all (it found no evidence and suggested treating the claim as false), and
whether Thumper's music is "generative" (primary sources describe
sequencer-authored levels; "generative" appears to be loose secondary usage).

It independently encountered the same TCRF prompt-injection attempt recorded at
the end of §7, and independently refused it.

---

## 9. Addendum, 2026-08-17: the sound-design pass

Months after this document was written, `docs/superpowers/specs/2026-08-16-sound-design-design.md`
(approved in conversation, then implemented) built most of §6's palette. This
records what shipped, what changed on the way and why, and the two ideas the
pass is actually built around, which are not in this document's palette at
all.

### What of §6 was built

- **§6.1, the bed.** The reactor (`audio/sound.ts`) is close to a literal
  read of this section: two oscillators ~0.4 Hz apart near 58 Hz, a lowpass
  with a 0.08 Hz LFO, present from run start, energy driving cutoff and
  pitch. **Not built**: the optional turn-rate gyro whine — this section's
  own hedge ("test whether it reads as a ship or as a dentist's drill") was
  never resolved because the layer itself was never written. **Changed**:
  the thrust layer became its own bed (`engine`) rather than a second
  parameter folded into the reactor's own cutoff — two sustained voices
  instead of one, which the nine-bus split (see below) made affordable in a
  way the original four-channel budget might not have.
- **§6.2, phasers.** Five of seven built close to the letter: total length
  under the repeat period, two pitches a minor third apart
  (`EOR #$14`, lifted), the range rule mapped to the downsweep floor, a
  separate return transient on a hit, hard band-limiting above 700 Hz. **Not
  built**: item 5, the three-stage held-buzz structure for a sustained
  trigger. Every shot is still a discrete one-shot at every fire rate,
  unmodified from what this document called "not a solvable mixing problem"
  for six-plus shots a second — §7's open question 3 is accordingly still
  open. Torpedoes: the four-layer report (punch/crack/body/tail) is close
  to §5's own explosion-stack recipe; the in-flight Doppler streak and the
  empty-chamber click were both proposed and neither was built —
  `player.torpedoes > 0` gates the whole call, so firing on empty is
  silence, not the dry mechanical click asked for.
- **§6.3, the alert.** Built essentially as specified, and it is the one
  place this document's own recommendation and the shipped code now agree
  outright on the central move: `game/alert.ts`'s `AlertPulse` is the
  Asteroids shape (fixed tone, shrinking gap) plus Patterson's decay (a
  held condition backs off after ~8s) plus the CHI 2024 constraint taken
  literally — urgency is spent entirely as added partials (`components`:
  1/2/4), and the level never moves. **Changed**: this section asked for
  the fatigue clock to reset "at each wave spawn"; the shipped `held` timer
  instead resets on any *condition* change (green/yellow/red) and is
  otherwise only cleared by `Session.restart` — a wave that arrives without
  changing the player's own condition does not refresh it. That is a
  narrower trigger than proposed, and it is not yet listed as its own
  question in `docs/todo.md` §2's alert-pulse entry. The Shepard glissando
  this section also proposed for the wave-escalation moment was not built;
  `wave()` still uses two detuned sawtooths and a noise swell instead.
- **§6.4, hostiles.** Each class has its own band and rhythm
  (`hostileFire`'s switch on `HostileKind`), and the Harrow's own
  reassignment from "never fires" to "the one you hear laying" shipped
  exactly as asked: `mineLay` (the drop) and `mineArm` (the arming click)
  are two distinct events, plus a proximity-scaled `mineTick`. Chain
  detonations inherit their existing stagger for free, since each mine's
  own `mineBlast` call already fires at the field's own scheduled time.
- **§6.5, the Shroud.** Built, and re-voiced once already on its own terms:
  the detuned-oscillator "roughness as uncertainty" device this section
  proposed for the decloak moved to the scanner ping instead
  (`audio/sound.ts`'s own file header explains why), and `decloak` itself
  became the `fm` voice's bell shape — an index that settles from
  inharmonic to plain across the whole wind-up, so the sound's own arc *is*
  the tell rather than a fixed texture standing in for one. The resolve
  still lands `CLOAK_WIND - 0.03` before the real bolt, as asked.
- **§6.6, docking.** All five stages are built and wired to the timings
  this section already cited as existing (`docking.ts` predates this pass).
  The A-N range (`approach`) is close to a literal read: off-course reads as
  interlocked dot/dash pulses, on-course collapses to one held tone.
  **Changed**: `hardDock` is not the two temporally offset strikes (a
  metallic latch, then a dull seat 30 ms later) §5's modal-ratio table
  proposed — it is a lowpass thud and an `fm`-voice bell arriving together,
  plus a bandpassed ring 20 ms behind, which reads as one dense impact
  rather than two distinguishable materials. `service`'s own four stages
  are one uniform rising figure (`SERVICE_NOTES`) rather than the four
  different resonators (bright ringing / duller tap / low surge / rack
  clatter) this section asked for — the one clear simplification, not yet
  recorded as an open question anywhere. The tally's arpeggio-by-multiplier
  shipped as proposed, including this document's own warning that it is
  speculative and unattested in the canon — that warning still stands.
- **§6.7, damage.** Built as specified: `shieldHit` pans and pitches by
  facing rather than by bolt origin (the facing is the information, not the
  incidental world position — a small, deliberate divergence this section
  did not anticipate but is consistent with its own "differentiate
  outcomes" rule), `breach` is the roughest sound in the bank, and
  `Bed.dip` marks hit-stop on the beds only, never on the transient that
  caused it.
- **§6.8, death.** Built close to the letter: a four-layer instant, driven
  by `DeathSequence.power` rather than a separate cut, and the drift is
  genuinely near-silent apart from the one scripted relay-tick blip.
- **§6.9, the multiplier through-line and the scanner's second ear.** Both
  built. `MOTIF` (`[0, 4, 7, 12]` over a 220 Hz root) is the "one family in
  four registers" this section asked for, realised as `deposit`/
  `multiplierTick`/`salvageTransfer`/`tally` — `salvageTransfer` is a fifth
  register this section did not itemise by name, added because `docking.ts`
  already has its own "SALVAGE TRANSFER" stage the through-line would
  otherwise skip. The scanner's ping gives it the second listening position
  this section asked for; §7's open question about the chart needing its
  own voice the same way is not yet answered — the chart was not part of
  this pass.
- **§6.10, silence.** Built: green is silent by construction
  (`AlertPulse.reset()`), the death drift is near-silent, and nothing makes
  a sound before the first keypress (unchanged from before this pass —
  `CLAUDE.md`'s own gotcha).

### What changed, in general, and why

Every deviation above is a simplification in the same direction: fewer
distinct materials per cue than the research recipe called for, in favour
of getting every cue built across five hostile classes, four service
stages, and a whole docking sequence rather than perfecting a smaller set.
`docs/todo.md` §2 does not yet carry the `hardDock`/`service` simplification
as its own tuning question; it should, the next time that section is
revisited, alongside the phaser's still-unbuilt held-buzz structure (§6.2's
item 5) and §7's open question 3, which the omission leaves genuinely open
rather than answered either way.

### The two additions the research did not propose

**The radio** (`audio/radio.ts`) and **the acoustics** (`audio/acoustics.ts`)
are both new relative to this whole document — nothing above proposed a
comms channel three parties speak through, or a computed per-sector room.
Both came from a different question than the one this document answers.
Everything above was found by asking *what worked, historically, and why* —
the canon's own answers to problems this game also has. The radio and the
room were found by asking a different question: **what would make this
game's own sound recognisably itself**, rather than a competent assembly of
borrowed answers. The war already had a voice in text — HQ dispatches, the
commander's name, the Warden's hails, the deck log — and giving it one in
sound, in an idiom that is speech-shaped but contains no words, is not a
move any of the sources above make; the closest relative is Star Wars'
TMS5220 (§1), which is content this project is barred from touching, not a
mechanism to imitate. The room is the same kind of move on the other axis:
nothing in §4's Duskers/Alien: Isolation material proposes computing a
convolution impulse response from the same seed that already decides a
sector's planet, moon or rock field, so that a `giant` sector and a `bare`
one are audibly different spaces before a single weapon fires. Both ideas
are downstream of this project's own locked decisions — synthesised audio,
no samples; a deck log built from the board it describes; a scanner that is
never wrong — rather than downstream of anything in this document's
research. That is the intended relationship: the canon supplies the
craft, the game's own rules supply the two ideas that make the result
recognisably *this* game's sound and not simply a well-built one.
