# Kobayashi — to do

A carry-into-the-next-session list. Ordered by what unblocks the most, not by
size. Everything here is either a known defect, a decision waiting on a human,
or a piece of scope that was deliberately left out.

Background is in [status.md](status.md); the locked decisions in `CLAUDE.md`
are not up for revisiting here.

---

## 1. Defects — known, reproducible, unfixed

### 1.1 The first WASD press in the command view is swallowed

**Reproduce:** enter the command view (die, wait for the epitaph to hand off),
press `d` — the sector cursor does not move. Press `d` again — it moves. Every
press after the first works.

Measured exactly:

```
press 1 of d: 60 -> 60   FAIL
press 2 of d: 60 -> 61   OK
press 3 of d: 61 -> 62   OK
```

The cursor snaps to `campaign.current` on that first press, which is what a
cursor *reset* looks like, not what a dropped keypress looks like.

**Disproven:** that the `previousPresentationMode` watcher in `src/main.ts` is
re-firing on the frame the key lands. A guard skipping the cursor reset while
`presentation.mode === "command"` did not change the symptom, so the reset is
happening somewhere else or for another reason. That guard was reverted rather
than left in with a comment asserting a cause that had just been falsified.

**Next diagnostic:** instrument the keydown handler to log, on the first press
only, what `handleCommandKey` receives and what `presentation.mode` and
`chartCursor` are at that instant. The dispatch to walk is:

```ts
if (DISPLAY_KEYS.has(key)) return;
if (presentation.mode === "command") { handleCommandKey(key); }
else if (presentation.mode === "run") { … }
else { presentation.startRun(); }
```

This is worth doing first. The player's repeated report that the command view
is unusable is partly this: their first input into the screen is eaten, which
reads as "the keys don't work" long before it reads as "off-by-one frame".

### 1.2 `NO DOCK HERE` is a lie

The chart and the arrival card both say it, and the world does not agree — the
starbase sits at one fixed world position however the chart is drawn. Either
make per-sector docking real or stop claiming it. Listed again under §3 because
making it true is a design decision, not a bug fix.

---

## 2. Tuning — needs a human at the keyboard, not more reasoning

Every constant below was chosen by reasoning about it. None has been played or
heard. This is the one block of work that cannot be done by thinking harder.

**Flight and combat**
`Ship.TURN_ACCEL / TURN_DAMP / MAX_TURN / DRAG`, `PHASER.falloffStart/End`,
`WAVE_BREAK`, multiplier gain, `HIT_STOP`, the death sequence's `TIMING`, the
attract loop's dwell times, the scanner sweep rate.

**The mix** — `BUS_LEVELS`, the phaser's cadence and pitch pair, the alert's
`FULL_THREAT`. Three to sit with first:

- the phaser at a held 6.25 shots a second — the only sound with a real chance
  of becoming fatiguing
- the alert's threat scaling — tension or nuisance, undecidable from source
- the decloak, which has to cut through a firefight without being the loudest
  thing in the game

**Impulse power** — `Ship.IMPULSE = 0.32` and `IMPULSE_FLOOR = 0.02`. Is
limping home at a third of thrust a mercy or a punishment?

**The jump's distance curve** — `JUMP.baseCharge = 1.4`, `JUMP.perStep = 0.35`.
This one changes combat: a hop next door is now cheaper than it was and a long
jump is dearer, with an eight-step ceiling on a full reserve. It is the change
most likely to want reverting, and nobody has flown it.

**The Warden's numbers** — visit rate (55–95s to the first, 115–195s to the
next), dwell (32s), fire rate (0.3 every 2.4s), station-keeping distance (34
units). The two that will show first are the visit rate — too often and it
stops being an event, too rarely and most runs never see one — and whether an
escort holding station 34 units off your quarter is company or clutter in a
wave-eight fight. Its comms land on the same HUD row as `WAVE 8` and
`HULL BREACH` and will sometimes step on one.

---

## 3. Design questions — open, and not answerable by a constant

### 3.1 Campaign balance: the cliff

`npm run campaignlength` finds no contested band. Five steps of ground per run
gives 0% wins; six gives 93%. Capping the pressure formula turns losses into
deadlocks rather than into wins — measured, so a cap is the wrong fix.

What is missing is a **feedback term**: something that slows the enemy as it
loses ground, or speeds the player up as they gain it. That is a design answer.
See status.md §3 for the measurements before proposing one.

### 3.2 `gainGround` wants a ruling

One step per wave cleared in the sector you are standing in. It appears in
neither design document, and without it `isWon` is unreachable — so it was
invented to close the loop. Per §3.1 it is the single number the whole campaign
hangs on. It deserves a deliberate decision rather than continued inheritance.

### 3.3 Should a bare sector really have nowhere to bank?

The design doc's own "greed loop, one level up". It is also the one change that
could leave a player carrying a fat multiplier with nowhere to realise it —
which is either the entire point or a trap. Decide, then make §1.2 true or
delete the claim.

### 3.4 Is the patrol priced right?

200 salvage, strength 3, one in the field plus one per yard. All invented;
`strategy-layer.md` leaves them open.

### 3.5 Should fitted refits be capped?

They are not, so a rich player eventually flies all six. Each is individually a
tradeoff and the downsides do stack, but "what am I building for this run"
collapses into "everything" once 3,050 salvage is affordable.

### 3.6 Is `1 + yield` the right salvage curve?

Implemented to avoid zeroing salvage in the yield-0 home sector, but it means a
yield-3 sector pays 4× rather than the documented 3×.

### 3.7 Is mouse aim an improvement, or does it remove the reason to turn?

Turning the ship is currently how you present a fresh shield quarter. Mouse aim
decouples those, and might hollow out the defensive skill the four facings
exist to create.

---

## 4. Audio revision against the research

`docs/audio-prior-art.md` landed *after* the audio layer was built and
disagrees with it in three places. The alert pulse was partially reworked
already; these remain:

- **Escalation should add partials, not raise level.** CHI 2024, n=1,699 —
  amplification alone measurably hurt perceived competence.
- **The compressor's 6 ms lookahead costs impact sync** in a game built around
  hit-stop. Either shorten it or accept the smear deliberately.
- **Verify the autoplay gesture path end to end.** The contract is that nothing
  sounds until a key is pressed and that the first failure retires the whole
  audio layer rather than raising in the frame loop. It has not been exercised
  against a machine with no audio device.

---

## 5. Not built, and deliberately so — revisit only if earned

- **Mouse aim** — see §3.7.
- **Leaderboards.**
- **Per-sector docking** — see §1.2 / §3.3.
- **Territorial control *during* a run** — only if the between-runs version
  earns it.
- **The exploration encounters from concept D**, seeded into empty sectors.

---

## 6. Housekeeping

- `npm run typecheck` before every commit. There is no lint step.
- `npm run playtest` needs a Playwright browser and a **fresh** dev server — a
  stale one predating new files fails with `__stage` undefined. Kill it and
  clear `node_modules/.vite`.
- `src/chart/` logic modules must not import `three` or touch the DOM.
  `ChartView.ts` is the sole exception and `tsconfig.campaign.json` excludes it.
  Breaking this breaks the whole campaign test cycle.
- `Documents/` is iCloud-synced. A duplicate-symbol typecheck failure means a
  `* 2.ts` conflict copy.
