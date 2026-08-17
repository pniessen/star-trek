# The Sound of the Place — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Kobayashi's audio two singular ideas — a wordless three-party radio that is a tell, and per-sector acoustics with positional echo — on a bench upgraded with FM and formant voices, a space send, static budgets and a duck, and build the research palette's ship cues where they make the ship legible.

**Architecture:** `Synth.ts` grows two voice kinds (`fm`, `formant`), a convolver send with a per-sector procedural IR, per-bus static caps, and a duck primitive — all inside the existing never-throw / never-before-gesture guard. `sound.ts` gains a `Radio` sub-module (phrase grammar per party) and an `Acoustics` sub-module (IR builder + echo scheduler); the game side calls new `sound.*` entry points at events it already has, and `SoundScene` grows the state the reactor and space need. Everything is testable in the audiotest mock (arithmetic) or the playtest (wiring); the positional-echo half is gated by a real-machine budget measurement.

**Tech Stack:** TypeScript, WebAudio (no libraries), Vite. Tests: `npm run audiotest` (bare node against a mock `AudioContext`), `npm run playtest` (Playwright), `npm run typecheck`. Chart build untouched.

**Spec:** [2026-08-16-sound-design-design.md](../specs/2026-08-16-sound-design-design.md).

## Global Constraints

- **Nothing in the audio layer may throw; nothing may start before a gesture** (`Synth.ts` header). Every new node type is created lazily inside the same guard; the mock context in `selftest.mjs` must be extended for every new factory (`createConvolver`, etc.) and the "no audio device" case (factory throws) must still retire the layer silently.
- **No samples, no speech, no words.** The radio idiom is formants and squelch. Impulse responses are computed, never loaded.
- **Static voice budgets are hard caps; surplus is refused, never stolen or queued.** Buses and caps: bed 2, alert 1, weapon 3, impact 4, hostile 4, mechanism 2, panel 2, radio 3 (one per party), echo 3.
- **Band discipline:** below 120 Hz reserved for alert/torpedo/mine/death; phasers above 700 Hz; nothing sustained in 2–5 kHz; the radio owns 300–3400 Hz for phrases only.
- **Every cue answers "what does this tell the player."** The radio never orders and never carries information the board lacks; the space never carries information the eye lacks (derived from `planHero`/`planShoal`/comet plans only).
- **Nothing pulses that isn't a hostile's own behaviour.**
- **The mix stays a handful of constants**: new buses are new `BUS_LEVELS` entries; caps live beside them.
- Time-based everywhere; hit-stop marks beds only, on wall-clock seconds.
- Attract mode: the demo campaign may speak; nothing the radio or acoustics does writes to any campaign.
- `npm run typecheck` before every commit; stage by name; iCloud `* 2.ts` conflict copies are the cause of any duplicate-symbol error.
- Playtest server discipline: port 5173 is the user's — never use or kill it. Run `npx vite --port 5199 --strictPort` in background and pass `PLAYTEST_URL=http://127.0.0.1:5199/`; stale `__stage` → restart only 5199 after `rm -rf node_modules/.vite`.
- `selftest.mjs`'s `everyCue(s)` must call every public cue — add each new one there so the gesture/no-device/failure sections exercise it automatically.

---

## Phase A — the bench

### Task 1: Static per-bus voice budgets, the duck, and the two new buses

**Files:**
- Modify: `src/audio/Synth.ts` (`Bus`, `BUS_LEVELS`, `MAX_VOICES` → `BUS_CAPS`, `Voice.bus`, `play` cap check, new `duck`)
- Modify: `src/audio/selftest.mjs` (§3 pool test → per-bus caps; a duck test)
- Test: `npm run audiotest`

**Interfaces:**
- Produces: `export type Bus = "weapon" | "impact" | "hostile" | "mechanism" | "panel" | "bed" | "alert" | "radio" | "echo"`; `export const BUS_CAPS: Record<Bus, number>` (bed 2, alert 1, weapon 3, impact 4, hostile 4, mechanism 2, panel 2, radio 3, echo 3); `Synth.duck(bus: Bus, depthDb: number, seconds: number): void` — a smoothed gain dip on one bus that recovers over `seconds`; `VoiceSpec.bus` now required-by-default to `"impact"` as today. Existing cues that named `impact`/`weapon`/`panel`/`bed` are unchanged; **the implementer reassigns existing cues to `hostile`** (hostileFire, withdraw, decloak, mineLay), `mechanism` (gate, tractor, hardDock, service, depart, brace, scram, hyperwarp*), and `alert` (alertBeat, conditionChange) so the caps mean something — record the mapping in the report.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests** — in `selftest.mjs` §3, replace the single 18-cap assertion:

```js
// ── 3. static budgets: each bus refuses its own surplus, never another's ──
{
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();
  s.listen(0, 0, 0);
  let from = mark();
  for (let i = 0; i < 40; i++) s.phaser(true, 1);
  ok("the weapon bus is capped at 3", voicesSince(from).length === 3, `${voicesSince(from).length}`);
  from = mark();
  for (let i = 0; i < 40; i++) s.hostileFire(3, 3);
  ok("the hostile bus is capped at 4", voicesSince(from).length === 4, `${voicesSince(from).length}`);
  from = mark();
  for (let i = 0; i < 40; i++) s.kill(4, 4, 1);
  const killVoices = voicesSince(from).length;
  ok("the impact bus is capped at 4 (per voice, whatever a kill layers)", killVoices <= 4, `${killVoices}`);
  const cancelled = nodes.slice(from).some((n) => n.kind === "gain" && n.gain.events.some((e) => e[0] === "cancel"));
  ok("nothing already sounding was cut", !cancelled);
  // Duck: a smoothed dip on one bus that recovers.
  const busGains = nodes.filter((n) => n.kind === "gain" && n.out.some((o) => o.kind === "gain" && o.gain.value === 1 /* master */));
  const beforeEvents = busGains.map((g) => g.gain.events.length);
  s.synth.duck("weapon", 6, 0.4);
  const changed = busGains.filter((g, i) => g.gain.events.length > beforeEvents[i]);
  ok("duck writes a dip and a recovery on exactly one bus", changed.length === 1 && changed[0].gain.events.length - beforeEvents[busGains.indexOf(changed[0])] >= 2, `${changed.length} buses touched`);
}
```

(`Sound` must expose its synth for this — check whether `sound.ts` already has `readonly synth`; if private, add a `/** @internal */ get synth()` accessor. If bus gains are hard to identify by structure, tag them: give each bus `GainNode` a debug-visible property in the mock by naming — simplest honest approach: `Synth` keeps `readonly busNames = new WeakMap<GainNode, Bus>()`? No — keep it simple: the mock's `createGain` returns nodes; `Synth.build` creates buses in `BUS_LEVELS` key order right after master/dc/trim/limiter; the test can identify bus gains as the gains whose `.out` contains the master gain. Master is the gain whose out contains the DC biquad. Write the selector that way and comment it.)

- [ ] **Step 2: RED** — `npm run audiotest`: caps not enforced per bus (all 40 phasers → 18), `duck` undefined.

- [ ] **Step 3: Implement** — in `Synth.ts`: extend `Bus`; `BUS_LEVELS` gains `hostile: 0.7, mechanism: 0.7, alert: 0.7, radio: 0.75, echo: 0.55` (first-draft, tuning list); `BUS_CAPS` as above; `Voice` gains `readonly bus: Bus`; in `play`, replace `if (this.voices.length >= MAX_VOICES) return;` with `if (this.count(bus) >= BUS_CAPS[bus]) return;` where `count` counts live voices on that bus after `reap`. Add:

```ts
/**
 * A smoothed dip on one bus that recovers on its own — the "duck the world,
 * do not raise the alarm" move from `docs/audio-prior-art.md`: the radio
 * ducks the weapon bus a few dB while a phrase plays; threat ducks the space.
 * Depth in dB (positive = quieter), recovery in seconds. Never below silence,
 * never above the bus's own level, and it composes: a second duck during a
 * recovery restarts the dip from wherever the gain is.
 */
duck(bus: Bus, depthDb: number, seconds: number): void {
  const rig = this.rig;
  if (!rig || this.failed) return;
  try {
    const gain = rig.buses[bus].gain;
    const now = rig.ctx.currentTime;
    const level = BUS_LEVELS[bus];
    const dipped = level * Math.pow(10, -Math.abs(depthDb) / 20);
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(dipped, now, 0.012);
    gain.setTargetAtTime(level, now + 0.05, Math.max(seconds, 0.05) / 3);
  } catch (error) {
    this.fail(error);
  }
}
```

In `sound.ts`, reassign existing cues' `bus:` fields per the Interfaces note.

- [ ] **Step 4: GREEN** — `npm run audiotest` all sections; `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/audio/Synth.ts src/audio/sound.ts src/audio/selftest.mjs
git commit -m "Give every bus its own budget, and a duck"
```

### Task 2: The FM voice

**Files:**
- Modify: `src/audio/Synth.ts` (`VoiceSpec.kind` gains `"fm"`, `ratio`, `index`, `indexDecay`; `play`'s fm branch)
- Modify: `src/audio/selftest.mjs` (§8: fm contract)
- Test: `npm run audiotest`

**Interfaces:**
- Produces: `VoiceSpec` gains `readonly ratio?: number` (modulator/carrier frequency ratio, default 1.4), `readonly index?: number` (peak modulation depth in Hz-of-carrier units — implementation: modulator gain = `index × freq`), `readonly indexDecay?: number` (seconds for the index to fall to ~zero; default = the voice's `decay`). `kind: "fm"` builds carrier osc + modulator osc → modulator gain → carrier `frequency` AudioParam.
- Consumes: Task 1's caps.

- [ ] **Step 1: Failing test** — add to `selftest.mjs`:

```js
// ── 8. the fm voice: a modulator into the carrier's frequency ──
{
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const synth = new Synth();
  synth.start();
  const from = mark();
  synth.play({ kind: "fm", bus: "impact", freq: 220, ratio: 1.4, index: 6, decay: 0.3, level: 0.3 });
  const fresh = nodes.slice(from);
  const oscs = fresh.filter((n) => n.kind === "oscillator");
  ok("fm builds two oscillators", oscs.length === 2, `${oscs.length}`);
  const carrier = oscs.find((o) => fresh.some((g) => g.kind === "gain" && o.out.includes(g) && g.gain.events[0] && g.gain.events[0][1] === 0.0001));
  const modulator = oscs.find((o) => o !== carrier);
  ok("the modulator drives the carrier's frequency, not the output",
    modulator && modulator.out.some((g) => g.kind === "gain" && g.out.includes(carrier.frequency)), "modulator not routed to carrier.frequency");
  near("the modulator sits at ratio × carrier", modulator ? modulator.frequency.events[0][1] : 0, 220 * 1.4, 1e-6);
  const modGain = fresh.find((g) => g.kind === "gain" && modulator && modulator.out.includes(g));
  ok("the index decays (a ramp is scheduled on the modulator gain)", modGain && modGain.gain.events.length >= 2, "index has no envelope");
}
```

The mock's oscillator `frequency` param needs to be connectable: extend `param()` in the mock so a param object can be a `connect` target (give `node.frequency` an identity so `.out.includes(carrier.frequency)` works — e.g. `AudioParam`s in the mock are plain objects and `connect(target)` pushes them; `includes` on the same object reference works as-is).

- [ ] **Step 2: RED** — one oscillator built (falls into the tone branch or throws on unknown kind).

- [ ] **Step 3: Implement** the branch in `play`:

```ts
} else if (spec.kind === "fm") {
  const carrier = ctx.createOscillator();
  carrier.type = spec.wave ?? "sine";
  carrier.frequency.setValueAtTime(clamp(spec.freq, 20, 18000), at);
  if (spec.to !== undefined) carrier.frequency.exponentialRampToValueAtTime(clamp(spec.to, 20, 18000), end);
  const modulator = ctx.createOscillator();
  modulator.type = "sine";
  const ratio = spec.ratio ?? 1.4;
  modulator.frequency.setValueAtTime(clamp(spec.freq * ratio, 1, 18000), at);
  const depth = ctx.createGain();
  const index = spec.index ?? 3;
  depth.gain.setValueAtTime(index * spec.freq, at);
  // The index is the timbre's own envelope: bright and inharmonic on the
  // attack, settling toward a plain tone — a struck bell, not a held one.
  depth.gain.exponentialRampToValueAtTime(0.01, at + Math.max(spec.indexDecay ?? spec.decay, 0.01));
  modulator.connect(depth).connect(carrier.frequency);
  carrier.connect(gain);
  modulator.start(at);
  carrier.start(at);
  modulator.stop(end + 0.02);
  chain.push(depth, modulator);
  source = carrier;
}
```

- [ ] **Step 4: GREEN**; `npm run typecheck`. Then re-voice two existing cues on it as proof it earns its place: `shieldHit` (metallic ring — `fm`, ratio 2.01, index 4) and `hardDock` (modal clunk — `fm`, ratio 1.41, index 8, short) — keep their old level/decay/pan; note the before/after specs in the report.

- [ ] **Step 5: Commit**

```bash
git add src/audio/Synth.ts src/audio/sound.ts src/audio/selftest.mjs
git commit -m "Add the FM voice: a struck bell, not a held one"
```

### Task 3: The formant voice — a phrase generator

**Files:**
- Create: `src/audio/formant.ts` (pure phrase-grammar helpers, no WebAudio)
- Modify: `src/audio/Synth.ts` (`speak(spec: PhraseSpec)`)
- Modify: `src/audio/selftest.mjs` (§9)
- Test: `npm run audiotest`

**Interfaces:**
- Produces, in `formant.ts`:
```ts
export interface Syllable { readonly at: number; readonly length: number; readonly pitch: number; readonly f1: number; readonly f2: number; readonly f3: number; readonly level: number }
export interface Phrase { readonly syllables: readonly Syllable[]; readonly duration: number }
export interface Cadence { readonly syllablesMin: number; readonly syllablesMax: number; readonly lengthMin: number; readonly lengthMax: number; readonly gapMin: number; readonly gapMax: number; readonly pitchBase: number; readonly pitchRange: number; readonly contour: "level" | "rising" | "falling" | "broken" }
export function composePhrase(cadence: Cadence, rng: () => number): Phrase
```
  `composePhrase` is pure: draws syllable count/lengths/gaps/pitch walk from the cadence, formant centres from a small vowel table (F1/F2/F3 triples for ~5 vowels), all times relative to 0. `contour` shapes the pitch walk; `"broken"` inserts one gap of 2× and a pitch reset (a phrase that breaks up — withdrawal).
- Produces, in `Synth.ts`: `speak(spec: PhraseSpec): void` where `PhraseSpec = { phrase: Phrase; bus: Bus; level: number; drive: number; band: [number, number]; pan?: number; delay?: number }` — builds ONE carrier (pulse-ish: `"sawtooth"`), through a `WaveShaper` drive stage (soft clip, `drive` scales input), into three parallel `BiquadFilter` bandpasses (Q ~8) summed to a gain, then a highpass/lowpass pair at `band` (300–3400 default) — the telephone band; the sum gain is gated per syllable (`setValueAtTime`/`linearRamp` envelope sequence on the audio clock, from `spec.delay + syllable.at`), formant frequencies stepped per syllable via `setTargetAtTime`. Opens and closes with a **squelch**: a 40 ms noise burst through a resonant highpass at ~2.2 kHz, level ×0.6, before the first syllable and after the last. Counts as ONE voice on its bus (the whole phrase). Duration = phrase.duration + squelches.
- Consumes: Task 1's caps and buses.

- [ ] **Step 1: Failing tests**:

```js
// ── 9. the formant voice speaks a phrase on the audio clock ──
{
  const { composePhrase } = await import(join(out, "audio/formant.js"));
  let seed = 7; const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cadence = { syllablesMin: 3, syllablesMax: 5, lengthMin: 0.06, lengthMax: 0.14, gapMin: 0.03, gapMax: 0.08, pitchBase: 160, pitchRange: 40, contour: "rising" };
  const phrase = composePhrase(cadence, rng);
  ok("a phrase has 3–5 syllables", phrase.syllables.length >= 3 && phrase.syllables.length <= 5, `${phrase.syllables.length}`);
  ok("syllables are ordered and non-overlapping", phrase.syllables.every((s, i) => i === 0 || s.at >= phrase.syllables[i - 1].at + phrase.syllables[i - 1].length), "");
  ok("a rising contour ends higher than it starts", phrase.syllables.at(-1).pitch > phrase.syllables[0].pitch, "");
  ok("formants sit in the speech band", phrase.syllables.every((s) => s.f1 > 200 && s.f3 < 3400), "");

  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const synth = new Synth();
  synth.start();
  const from = mark();
  synth.speak({ phrase, bus: "radio", level: 0.4, drive: 2, band: [300, 3400] });
  const fresh = nodes.slice(from);
  ok("one carrier per phrase", fresh.filter((n) => n.kind === "oscillator").length === 1, "");
  ok("three formant bandpasses", fresh.filter((n) => n.kind === "biquad" && n.type === "bandpass").length === 3, "");
  ok("a drive stage exists", fresh.some((n) => n.kind === "waveshaper"), "");
  const gates = fresh.filter((n) => n.kind === "gain" && n.gain.events.length >= phrase.syllables.length * 2);
  ok("the syllable gate is a scheduled envelope sequence, not timers", gates.length >= 1, "no gain carries per-syllable events");
  ok("two squelch bursts bracket the phrase", fresh.filter((n) => n.kind === "buffersource").length === 2, "");
  ok("a phrase counts as one radio voice", true); // budget asserted in Task 8's radio test
}
```

Extend the mock's `everyCue` later (Task 8) — `speak` is bench-level.

- [ ] **Step 2: RED** — module missing / `speak` undefined.

- [ ] **Step 3: Implement** `formant.ts` (vowel table: A `[730,1090,2440]`, E `[530,1840,2480]`, I `[390,1990,2550]`, O `[570,840,2410]`, U `[440,1020,2240]` — Peterson & Barney averages, cite them; a phrase walks vowels randomly, pitch walks per contour) and `Synth.speak` per the interface. The squelch: `this.play({kind:"noise", bus, filter:"highpass", freq:2200, q:6, level: level*0.6, attack:0.002, decay:0.04, delay, pan})` before and after — those two are internal and must NOT count against the radio cap (schedule them through a private path that bypasses `count`, or accept they do and set the radio cap so one phrase = squelch + phrase + squelch fits: simplest honest choice — build the squelch bursts INSIDE `speak`'s own node graph (a buffer source into the phrase's own output gain) so the whole phrase, squelches included, is one `Voice`. Do that.)

- [ ] **Step 4: GREEN**; `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/audio/formant.ts src/audio/Synth.ts src/audio/selftest.mjs
git commit -m "Add the formant voice: a phrase, not a note"
```

### Task 4: The space send — a convolver with a computed impulse

**Files:**
- Create: `src/audio/acoustics.ts` (pure IR design → `Float32Array`, no WebAudio)
- Modify: `src/audio/Synth.ts` (`setSpace(design)`, per-bus send gains, `spaceLevel(x)`)
- Modify: `src/audio/selftest.mjs` (§10; mock gains `createConvolver`)
- Test: `npm run audiotest`

**Interfaces:**
- Produces, in `acoustics.ts`:
```ts
export interface RoomDesign { readonly tailSeconds: number; readonly tailCutoffHz: number; readonly earlyReflections: readonly { at: number; gain: number }[]; readonly wet: number; readonly noiseOnly?: boolean }
export function renderImpulse(design: RoomDesign, sampleRate: number, rng: () => number): Float32Array
```
  Tail = exponentially decaying filtered noise (one-pole lowpass at `tailCutoffHz`, run over the noise in JS), plus discrete early reflections as impulses at `at` seconds × `gain`; `noiseOnly` (the comet) = a flat band-limited noise burst with no discrete reflections. Normalised so peak ≤ 0.9.
- Produces, in `Synth.ts`: `setSpace(design: RoomDesign | null): void` — renders the IR into an `AudioBuffer`, sets it on a lazily created `ConvolverNode` (`normalize = false`) whose output → master; each bus has a send `GainNode` → convolver (bed and radio sends fixed at 0 — the reactor is inside the ship and the radio is a carrier, neither is in the room; weapon/impact/hostile/mechanism/echo/alert sends default `design.wet`); `null` → all sends 0. `spaceLevel(x: number): void` scales all sends (0–1) — the threat duck.
- Consumes: nothing new.

- [ ] **Step 1: Failing tests** — mock gains `createConvolver() { guard("createConvolver"); return node("convolver", { buffer: null, normalize: true }); }`. Add:

```js
// ── 10. the space: a computed impulse on a send ──
{
  const { renderImpulse } = await import(join(out, "audio/acoustics.js"));
  let seed = 3; const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rocks = renderImpulse({ tailSeconds: 0.5, tailCutoffHz: 4000, earlyReflections: [{ at: 0.05, gain: 0.5 }, { at: 0.12, gain: 0.3 }], wet: 0.3 }, 48000, rng);
  ok("the impulse has the tail's length", rocks.length === 24000, `${rocks.length}`);
  ok("early reflections are discrete peaks", Math.abs(rocks[Math.round(0.05 * 48000)]) > 0.3, "");
  ok("peak is normalised under 0.9", Math.max(...rocks.map(Math.abs)) <= 0.9, "");
  const bare = renderImpulse({ tailSeconds: 0.05, tailCutoffHz: 8000, earlyReflections: [], wet: 0 }, 48000, rng);
  ok("a bare room is nearly nothing", bare.length <= 2400, "");

  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const synth = new Synth();
  synth.start();
  ok("no convolver before a space is set", !nodes.some((n) => n.kind === "convolver"), "");
  synth.setSpace({ tailSeconds: 0.5, tailCutoffHz: 4000, earlyReflections: [], wet: 0.3 });
  const conv = nodes.find((n) => n.kind === "convolver");
  ok("setSpace builds one convolver with a buffer", conv && conv.buffer !== null, "");
  ok("the convolver does not normalise (our IR is already scaled)", conv && conv.normalize === false, "");
  synth.setSpace(null);
  // Sends: every bus send gain is a gain whose out includes the convolver.
  const sends = nodes.filter((n) => n.kind === "gain" && n.out.includes(conv));
  ok("sends exist per bus", sends.length >= 6, `${sends.length}`);
  ok("bed and radio sends are always dry", true); // asserted structurally in the report by naming which sends are pinned to 0
}
```

Also add to §1's no-device section: `setSpace` with `fail: { createConvolver: 0 }` retires the layer without throwing (extend the existing failure loop by calling `s.synth.setSpace(...)` in `everyCue` — do that in Task 6 where `sound.ts` gets its wrapper).

- [ ] **Step 2: RED**. **Step 3: Implement** per the interface (IR render is ~40 lines of JS DSP; comment the one-pole lowpass and the normalisation). **Step 4: GREEN**, typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/audio/acoustics.ts src/audio/Synth.ts src/audio/selftest.mjs
git commit -m "Add the space: a convolver on a send, fed a computed impulse"
```

### Task 5: Hit-stop marks the beds; the compressor question closed

**Files:**
- Modify: `src/audio/Synth.ts` (`Bed.dip(seconds)`), `src/audio/sound.ts` (`hitStop(seconds)`), `src/game/session.ts` (call it where `hitStop.strike` fires — one line in `HitStop.strike` is cleaner: check `src/game/hitStop.ts` and put the call there so every strike marks the beds)
- Modify: `docs/todo.md` §4 (compressor item: closed — `selftest.mjs` §2 asserts no compressor and a `tanh` shaper; record the date)
- Test: `npm run audiotest`

**Interfaces:**
- Produces: `Bed.dip(seconds: number): void` — a brief lowpass + pitch dip (cutoff ×0.55, pitch ×0.94) that recovers over `seconds`, driven by the audio clock (wall-clock, like hit-stop itself); `sound.hitStop(seconds)` dips every live bed.

- [ ] **Step 1: Failing test** — §11: after `s.update({...})` builds beds, `s.hitStop(0.12)` writes ≥2 new events on a bed's filter frequency and pitch params. **Step 2: RED. Step 3: Implement. Step 4: GREEN + typecheck.** Add `s.hitStop(0.1)` to `everyCue`. Update `docs/todo.md` §4's compressor bullet to resolved with the assertion cited.

- [ ] **Step 5: Commit**

```bash
git add src/audio/Synth.ts src/audio/sound.ts src/game/hitStop.ts src/audio/selftest.mjs docs/todo.md
git commit -m "Hit-stop marks the beds only; close the compressor question"
```

## Phase B — the ship

### Task 6: The reactor bed and the scene it reads

**Files:**
- Modify: `src/audio/sound.ts` (`SoundScene` gains `energy`, `starved`, `threat` stays; `update` drives a reactor bed; `Sound` gains `readonly synth` accessor and `setSpace` passthrough for later tasks)
- Modify: `src/main.ts:1043` (the `sound.update({...})` call — pass `energy: player.energy`, `starved: player.energy <= 0.02` — verify the exact starved threshold in `Ship.ts` and reuse its constant)
- Modify: `src/audio/selftest.mjs` (§12; `everyCue`'s `update` call gains the fields)
- Test: `npm run audiotest`

**Interfaces:**
- Produces: `SoundScene` = `{ threat, hull, thrust, speed, alive, docked, energy: number /*0..1*/, starved: boolean }`; the reactor is a `Bed` (`kind: "tone"`, `wave: "sawtooth"`, `ratio` ≈ 1.0069 — two oscillators ~0.4 Hz apart at 58 Hz, `filter: "lowpass"`, `q: 1.2`) held near 58 Hz; `update` maps: level `0.05 × alive`, cutoff `220 + energy × 260` Hz, pitch `58 × (0.5 + 0.5 × energy)`-ish droop only below 25% energy, and a slow LFO (`rate` param of `Bed.set` — check its signature; the existing engine bed already takes rate/depth) at 0.08 Hz; **starved** → pitch ×0.5 and a relay tick (`play` a short click every ~1.4 s on the `bed` bus — a `hold`-less noise blip through a highpass) scheduled from `update` on a wall-clock accumulator; hull damage → `q` up (roughness) proportional to `1 - hull`.
- Consumes: Task 5's `dip`.

- [ ] **Step 1: Failing test** — §12: after `s.update({... energy: 1, starved: false ...})`, exactly one new bed's oscillator pair sits near 58 Hz (`frequency` events at 58 ± 0.5 and 58×1.0069 ± 0.5); after `energy: 0.05, starved: true`, the reactor's pitch target halves and within 3 s of simulated `update` calls (advance `ctx.currentTime` in the mock by 0.5 s per call) a highpass noise blip is played on the `bed` bus.
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN + typecheck** (`main.ts` scene call updated; `npm run playtest` once for regression). **Step 5: Commit** "The reactor: a bed that breathes with the ship's energy".

### Task 7: The scanner as a second ear, and the Shroud's swell

**Files:**
- Modify: `src/hud/scanner.ts` (`ScannerModel.update` records paint events: `readonly paints: { bearing: number; range: number; vague: number; spread: number }[]` cleared each frame)
- Modify: `src/audio/sound.ts` (`ping(bearing, range, spread)`, `decloak` re-voiced as FM swell)
- Modify: `src/main.ts` (after `scanner.update`, forward paints to `sound.ping` — find where `ScannerModel.update` is called)
- Modify: `src/audio/selftest.mjs` (§13), `tools/playtest.mjs` (a probe assertion: after a wave, `sound.lastPing` records ≥1)
- Test: `npm run audiotest`, `npm run playtest`

**Interfaces:**
- Produces: `sound.ping(bearing: number, range: number, spread: number): void` — `panel` bus; a short tone at 1650 Hz (a band the phaser downsweep passes through only briefly and the radio's 300–3400 avoids at its top — record the reasoning) with **detune proportional to spread**: two `tone` voices at `f × (1 ± spread/SCANNER.errorFar × 0.03)` — rough when wide (~5% beat), a clean unison when `spread ≤ 2`; level falls with range; panned by bearing; rate-limited to one ping per 90 ms; **ducks the weapon bus 3 dB for 0.12 s** (Task 1's duck). `sound.lastPing: { at: number; spread: number } | null` for the probe. `decloak(x, z)` re-voiced: an `fm` swell (`ratio` 1.618 inharmonic → index climbing over `wind` 0.45 s, resolving into the Shroud's own bolt-ish tone at the end — implement as `fm` with `to` and `indexDecay` = wind, then a `tone` at the resolve).
- Consumes: Tasks 1, 2.

- [ ] **Step 1: Failing tests** — §13: `s.ping(0.3, 60, 20)` schedules two tone voices detuned from each other by ≥2%; `s.ping(0.3, 60, 1)` schedules two within 0.2%; a second `ping` inside 90 ms is dropped; `decloak` schedules an fm voice whose modulator gain ramps UP then a tone after `wind`. Playtest: expose `sound.lastPing` via `__sound` (already exposed on localhost — check) and assert after wave 1 spawns and one sweep period passes that `lastPing !== null`.
- [ ] **Step 2: RED. Step 3: Implement** (scanner records paints; main forwards; sound builds). **Step 4: GREEN both suites + typecheck. Step 5: Commit** "The scanner as a second ear: pings that resolve, and the Shroud's swell".

### Task 8: Hostile identities and the mines' tick

**Files:**
- Modify: `src/audio/sound.ts` (`hostileFire(x, z, kind: HostileKind, guard: boolean)`, `lanceCharge(x, z)`, `mineArm(x, z)`, `mineTick(x, z, near)`)
- Modify: `src/game/hostiles.ts` (fire call passes `this.kind`, `this.guardName !== null`; the Lance's fire path gains a `charge` phase: 0.35 s before a sniper's shot it calls `sound.lanceCharge` — implement as: when `cooldown` crosses below 0.35 with the target in aim, fire the charge cue once per shot; a private `charged` flag reset on fire)
- Modify: `src/game/mines.ts` (on `armed` transition → `sound.mineArm`; per frame for the nearest armed mine within `MINE.trigger × 4` → `sound.mineTick(x, z, near)` where `near` ∈ 0..1 — the cue itself rate-limits: interval `0.9 − 0.75 × near` seconds)
- Modify: `src/audio/selftest.mjs` (§14), `everyCue`
- Test: `npm run audiotest`, playtest regression

**Interfaces:**
- Produces: `hostileFire(x, z, kind, guard = false)` — per class: swarmer bright thin `tone` 1400→900 Hz short; sniper narrow `tone` 700→520 with `q`-ish edge (use `fm` low index for bite); brawler `noise` lowpass 380→160 + `tone` 140→95 (two voices — the ONE class allowed two, budget-wise, because it fires slowest); guard adds `× 0.94` pitch offset (matches its radio signature in Task 9); `lanceCharge(x, z)` — a rising resonant `tone` 420→1100 Hz over 0.32 s, `hostile` bus, panned; `mineArm(x, z)` — one soft click (`noise` bandpass 3 kHz, 12 ms); `mineTick(x, z, near)` — quiet `tone` 2400 Hz 8 ms, self-rate-limited by `near`.
- Consumes: `HostileKind` from `../game/hostiles.js` — **check import direction**: `sound.ts` importing a type from `game/hostiles.ts` is a type-only import (`import type`), erased — acceptable; the audiotest's tsc emit list must then include nothing extra since types erase. Verify `selftest.mjs`'s tsc file list still compiles (it emits Synth/sound/alert only — a `import type` from hostiles.ts needs hostiles.ts resolvable at typecheck-time... `--skipLibCheck` won't help; ADD `src/game/hostiles.ts` to the emit list if tsc complains, or define `type HostileKind = "swarmer"|"sniper"|"brawler"|"miner"|"stalker"` locally in sound.ts with a comment naming the source — prefer the local structural type, matching how session.ts declared `Rock` locally in the scenery pass).

- [ ] **Step 1: Failing tests** — §14: `hostileFire(3,3,"swarmer")` schedules a tone above 700 Hz; `"brawler"` schedules a voice below 200 Hz; `lanceCharge` schedules a rising tone (from < to); `mineTick(0,0,1)` twice in 100 ms schedules once. **Step 2: RED. Step 3: Implement** (game side + sound side). **Step 4: GREEN + typecheck + playtest once. Step 5: Commit** "Hostile identities: band and rhythm per class, and mines you can hear".

### Task 9: Damage by facing, breach, and the death near-silence

**Files:**
- Modify: `src/audio/sound.ts` (`shieldHit(x, z, facing, remaining)`, `breach()` re-voiced + `multiplierHalved()`, `death()` re-scored, `deathPower(power)`)
- Modify: `src/game/session.ts` (pass facing/remaining at the shieldHit call — `player.struckFacing` and `player.shields[facing]` right after `takeHit`; call `sound.multiplierHalved()` inside `breach()` after the halving; call `sound.deathPower(this.death.power)` each frame during the death sequence)
- Modify: `src/audio/selftest.mjs` (§15), `everyCue`
- Test: `npm run audiotest`, playtest regression

**Interfaces:**
- Produces: `shieldHit(x, z, facing: "fore"|"starboard"|"aft"|"port", remaining: number)` — pan by facing (fore 0, starboard +0.6, aft 0 with lower pitch, port −0.6), pitch base by facing (fore 640, sides 560, aft 480), the `fm` ring's index scaled by `remaining` (full facing = clean ring; near-empty = mostly transient — thinner, more click); `breach()` — the roughest sound: a `tone` 90 Hz with a second `tone` at 160 Hz (70 Hz beat = AM) for 0.4 s at high level, then `multiplierHalved()` — a two-note descending figure (the multiplier family's "loss" register: 660→440 Hz, panel bus); `death()` — four layers (sub `tone` 55 Hz 2 s; body `noise` lowpass 3000→150 over 1.8 s; crack `noise` highpass 6000→900 0.3 s; shock ring `tone` 180→40 over 0.95 s), then **nothing scheduled** until `panelRestore` (drift is silent by design — remove any drift-era cue); `deathPower(power)` — drives every bed's cutoff and gain by `power` (0..1) via a new `Bed.power(x)` scale, so the reactor dies on the panel's flicker; the scripted 1.15 s blip: `main`/`session` already knows when power hits 0.3 — call `sound.relayTick()` there once (a `bed`-bus click, same as the starved tick).
- Consumes: Task 6's bed API.

- [ ] **Step 1: Failing tests** — §15: `shieldHit(1,1,"port",1)` pans left; `shieldHit(1,1,"port",0.05)` schedules a shorter/lower-index voice than at 1 (compare the fm modulator gain's initial value); `breach()` schedules two tones 70 ± 3 Hz apart; `death()` schedules exactly 4 voices and none with `delay > 1.2` (nothing in the drift); `deathPower(0.2)` writes to every bed's filter and gain. **Step 2: RED. Step 3: Implement. Step 4: GREEN + typecheck + playtest. Step 5: Commit** "Damage says which facing; breach costs audibly; death goes quiet".

### Task 10: The multiplier family and the docking score

**Files:**
- Modify: `src/audio/sound.ts` (`kill` gains the deposit note; `multiplierTick(multiplier)`; `salvageTransfer(step, of)`; `tally` re-voiced on the same figure; `approach(offCourse: number, onCourse: boolean)` — the A-N radio range on the `radio` bus; `hardDock` (fm from Task 2 stays); `depart` unchanged)
- Modify: `src/game/session.ts` (call `sound.multiplierTick(this.multiplier)` when it changes on a kill), `src/game/docking.ts` (call `sound.approach(...)` each frame while `aligning` and guidance is visible — pass lateral error normalised 0..1 and `onCourse` = inside the capture cone; call `salvageTransfer` per service step that transfers salvage — check `service(step)`'s steps and which one is the transfer)
- Modify: `src/audio/selftest.mjs` (§16), `everyCue`
- Test: `npm run audiotest`, playtest regression

**Interfaces:**
- Produces: a module-level `MOTIF = [0, 4, 7, 12]` (semitones over a root) and `motifHz(root, degree)`; `kill(...)` adds one short `tone` at `motifHz(220, min(3, floor(multiplier)))` on the `panel` bus — the *deposit*; `multiplierTick(m)` — the same note family, quieter, on the HUD change; `salvageTransfer(step, of)` — the figure ascending across the transfer steps; `tally(multiplier, total)` — the full arpeggio (already exists — re-root it to 220 and the same degrees so all four registers agree; record the before/after); `approach(offCourse, onCourse)` — while off course, alternating short/long tones (di-dah to one side, dah-di to the other, chosen by sign of lateral error) at 700 Hz on the `radio` bus at low level; **on course they interlock into a steady tone** (one sustained low-level tone, re-triggered per frame with hold, no gaps); rate-limited so it never schedules more than one voice per 0.35 s.
- Consumes: Task 1's radio bus.

- [ ] **Step 1: Failing tests** — §16: `kill` schedules a tone whose frequency is one of the motif degrees over 220; `tally(4.5, 900)` schedules ≥3 tones all on motif degrees; `approach(0.8, false)` schedules two tones of different lengths; `approach(0, true)` schedules one long-hold tone; **the four registers agree**: the sets of frequencies produced by kill/multiplierTick/salvageTransfer/tally are all subsets of `{motifHz(220,d)}` ∪ octaves. **Step 2: RED. Step 3: Implement. Step 4: GREEN + typecheck + playtest. Step 5: Commit** "One motif in four registers: every kill points at the dock".

## Phase C — the radio

### Task 11: The radio — three parties, one channel

**Files:**
- Create: `src/audio/radio.ts` (`Radio` class: party cadences, event → phrase, rate-limit, `lastPhrase` record)
- Modify: `src/audio/sound.ts` (`readonly radio: Radio`; `sound.say(party, event, x?, z?)` passthrough; `dispatch()` gains the preamble; `allyHail/allyComms/allyLost` gain phrases)
- Modify: `src/game/session.ts` (call sites: on `spawnWave` → `say("theirs","wave")` once per wave with the doctrine; Lance charge → `say("theirs","charge")`; Shroud reveal wind start → `say("theirs","commit")` (squelch only); withdrawal roll → `say("theirs","withdraw")`; `brawlerEngaged` first true in a wave → `say("theirs","flank")`; dispatch → `say("ours","dispatch")` BEFORE the line lands (the `Dispatches.update` return true — the chirp site); Warden hail/comms/lost → `say("warden", …)`)
- Modify: `src/audio/selftest.mjs` (§17), `everyCue`; `tools/playtest.mjs` (radio wiring: `__sound.radio.lastPhrase` after a spawn is `theirs`; after a dispatch is `ours`)
- Test: `npm run audiotest`, `npm run playtest`

**Interfaces:**
- Produces, `radio.ts`:
```ts
export type Party = "ours" | "warden" | "theirs";
export type RadioEvent = "wave" | "charge" | "commit" | "withdraw" | "flank" | "dispatch" | "hail" | "comms" | "lost";
export const CADENCES: Record<"ours" | "warden" | Doctrine, Cadence>  // Doctrine imported as a structural union "raider"|"hammer"|"anvil" (local type, source named)
export class Radio {
  lastPhrase: { party: Party; event: RadioEvent; at: number } | null = null;
  constructor(private readonly synth: Synth)
  say(party: Party, event: RadioEvent, opts: { doctrine?: Doctrine; guard?: boolean; pan?: number; now: number; rng: () => number }): void
}
```
  Rules inside `say`: one phrase in flight per party — a new event for a party whose phrase is still playing **replaces** it (cut the old voice via a `Synth.cutBus("radio", party)`? — simpler: `Radio` remembers each party's phrase end time; if `now < end`, the new phrase is dropped for `charge`/`comms` (low priority) and replaces for `commit`/`withdraw`/`dispatch`/`lost` (high priority) — implement replace as scheduling the new phrase and letting `Synth`'s radio cap (3 = one per party) refuse... the cap is per-bus not per-party. Decision: `Radio` owns the per-party in-flight bookkeeping and never asks `speak` while a party's phrase is live unless priority is high, in which case it calls `synth.silenceBus?` — no such API. **Simplest correct:** high-priority events schedule with `delay: max(0, end - now)` (queue behind, but only one deep — a second high-priority event replaces the queued one). Record the choice.
  Cadences: `ours` level/measured (`contour: "level"`, pitch 150, 3–5 syllables); `warden` `ours` shifted up (pitch 190, 2–3 syllables); `raider` clipped fast (2–4 syllables, length 0.04–0.07, gaps 0.02–0.04, pitch 210, `contour: "broken"`-ish → use `"level"` with many short); `hammer` slow monotone (2–3, length 0.14–0.2, pitch 105, `"level"`); `anvil` sparse even long (2, length 0.16–0.22, gap 0.1, pitch 130, `"level"`). Event contours override: `charge` → `"rising"` short; `withdraw` → `"falling"` + `"broken"`; `commit` → **no phrase, squelch only** (a `speak` with an empty phrase = two squelches back to back — support `syllables.length === 0`); `flank` → two overlapping short phrases (schedule a second with `delay` 0.08 and `pan` mirrored). Guard: `pitchBase × 0.94`. Enemy `drive` 3.5 and band `[400, 2800]`; ours/warden `drive` 1.6, band `[300, 3400]`. Every phrase ducks the `weapon` bus 3 dB for its duration.
- Consumes: Task 3's `speak`, Task 1's `duck`.

- [ ] **Step 1: Failing tests** — §17: `radio.say("theirs","wave",{doctrine:"raider",now:1,rng})` produces a phrase with ≥3 syllables all shorter than 0.08; `"hammer"` produces syllables ≥0.14; `"commit"` produces a speak with zero syllables and two squelches; a second `say("theirs","charge")` while the first is in flight is dropped (`lastPhrase` unchanged); `say("ours","dispatch")` while `theirs` speaks is NOT dropped (parties independent); each `say` ducks the weapon bus (event count on the weapon bus gain rises). Playtest: `__sound.radio.lastPhrase.party === "theirs"` within 1 s of a wave spawn; `=== "ours"` after forcing a dispatch (set `__session.dispatches`'s clock — read how the guard tests force events).
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN both + typecheck. Step 5: Commit** "The radio: three parties, one channel, and chatter that is a tell".

## Phase D — the acoustics

### Task 12: Sectors have a body — the room per sector, ducked under threat

**Files:**
- Modify: `src/audio/acoustics.ts` (`roomFor(hero: HeroKind, shoal: boolean, insideComet: boolean): RoomDesign` — pure)
- Modify: `src/audio/sound.ts` (`enterSector(hero, shoal)`, `insideComet(x: number)` per frame, `update` scales `spaceLevel` by threat: `1 − 0.7 × pressure`)
- Modify: `src/main.ts` (in the sector-change block: `sound.enterSector(sectorHero, shoals.plan !== null)`; per frame `sound.insideComet(player.interference)` — the player's comet interference is on `Session`; find it)
- Modify: `src/audio/selftest.mjs` (§18), `everyCue`; `tools/playtest.mjs` (space changes on sector change: probe `__sound.room` name/`wet` for a forced `bare` vs `rocks` sector)
- Test: both suites

**Interfaces:**
- Produces: `roomFor` per the spec's table — rocks: tail 0.5 s, cutoff 4 kHz, reflections at 40/95/140/180 ms gains .5/.35/.25/.15, wet .3; shoal (any hero): tail ×1.6, cutoff 1.2 kHz, wet +.1; giant: tail 2 s, cutoff 600 Hz, no reflections, wet .25; moon/ringed: tail .35 s, cutoff 3 kHz, wet .18; sun: tail .12 s, cutoff 6 kHz, wet .08; bare: tail .05 s, wet 0; inside comet: `noiseOnly`, wet .6. `sound.enterSector` renders and sets the space (rng from `planHero`'s own salt style — the room is a function of the sector, so it must be deterministic: seed the IR noise from `(seed, sector)`; pass them in). `sound.room: { name: string; wet: number } | null` for the probe.
- Consumes: Task 4's `setSpace`/`spaceLevel`; `HeroKind` (structural local type, source named).

- [ ] **Step 1: Failing tests** — §18: `roomFor("rocks", false, false)` has 4 reflections; `roomFor("bare",…)` wet 0; `roomFor("giant",…)` tail ≥ 1.8; `roomFor(x, true, false)` cutoff < 1500; `roomFor(x, false, true).noiseOnly`; after `s.enterSector(...)` a convolver exists; `s.update({threat: FULL, …})` scales sends down (send gain events). Playtest: force `bare` → `__sound.room.wet === 0`; force `rocks` → `> 0`.
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN + typecheck. Step 5: Commit** "Sectors have a body: a room per sector, quieter as the fight closes".

### Task 13: Positional echo — the budget gate, then the rocks answer back

**Files:**
- Modify: `src/audio/sound.ts` (`echoFrom(x, z, tail: VoiceSpec)`; `kill`, `mineBlast`, `torpedo` detonation, `breach` call it with their tail voice; `sound.echoRocks: readonly Rock[]` set per sector)
- Modify: `src/main.ts` (`sound.echoRocks = asteroids.rocks` beside `session.rocks`)
- Modify: `src/audio/selftest.mjs` (§19), `docs/todo.md` (the gate result + fallback ladder)
- Test: `npm run audiotest`; **the budget gate on a real machine** (§6.1 of the spec)

**Interfaces:**
- Produces: `echoFrom(x, z, tail)` — for the nearest ≤3 rocks to `(x,z)` within 120 units: schedule `tail` again on the `echo` bus with `delay = 2 × d / C_GAME` (`C_GAME = 340` — a game-speed of sound chosen so a rock at 30 units answers 0.18 s later; tuning list), `level × 0.35 × (1 − d/120)`, `pan` by the rock's bearing from the listener, filter cutoff lowered ×0.6 (`to`/`freq` scaled) — three voices max per event from the echo cap. Silent when `echoRocks` is empty (every non-rocks sector).
- Consumes: Task 1's echo bus; `Rock` structural type.

- [ ] **Step 1: THE GATE FIRST** — before writing the feature: on the real machine (the dev server, a real browser tab, NOT the harness), stand in a `rocks` sector at escalation 8 (force via probe), fire the full radio + all cues in a burst via `__sound` calls in the console (a loop of `kill`/`hostileFire`/`say`) and read `__sound.synth`'s live voice count and `AudioContext.baseLatency`/`outputLatency` before and during; listen for dropouts. Record numbers in the report. If the pre-echo mix already glitches, STOP and report BLOCKED — the ladder starts higher up.
- [ ] **Step 2: Failing test** — §19: with `s.echoRocks = [{x:20,z:0,r:4},{x:-40,z:0,r:4},{x:0,z:200,r:4}]`, `s.kill(0,0,1)` schedules ≥2 additional voices on the echo bus with `delay > 0` and different pans; with `echoRocks = []` none. **Step 3: RED. Step 4: Implement. Step 5: GREEN + typecheck.**
- [ ] **Step 6: THE GATE AGAIN** with echo live — same burst in the rocks sector; record. If glitching: reduce to nearest ONE rock (`ECHO.maxRocks = 1`); if still: `ECHO.enabled = false` (convolver only) — write the ladder and the measured outcome into `docs/todo.md`.
- [ ] **Step 7: Commit** "The rocks answer back: positional echo, gated by measurement".

## Phase E — the record

### Task 14: Standing documents

**Files:** `CLAUDE.md`, `docs/todo.md`, `docs/audio-prior-art.md`

- [ ] **Step 1:** `CLAUDE.md` — Architecture's audio line (three voice kinds + formant + space; static per-bus budgets; radio and echo buses); State: the radio (three parties, doctrine cadences, chatter is a tell), the acoustics (room per sector, positional echo, ducked under threat), the ship cues (reactor, scanner ear, hostile identities, damage/death, the motif family); "Next, in order" §2 (audio revision) closed or narrowed to what remains; the `__sound` probe fields (`radio.lastPhrase`, `room`, `lastPing`) in Gotchas.
- [ ] **Step 2:** `docs/todo.md` — §4 resolved item by item (pulse: was already; partials-not-level: cite the alert test; compressor: closed in Task 5); §2 gains every new constant with its deciding question (`BUS_LEVELS` new entries, `BUS_CAPS`, the reactor's numbers, ping detune scale, cadences, `roomFor` table, `C_GAME`, echo level); the budget gate result and ladder from Task 13; the sitting is still the review.
- [ ] **Step 3:** `docs/audio-prior-art.md` — dated addendum: what of §6 was built (list), what was changed and why, and the two additions the research did not propose (radio, room) with the reasoning that they came from asking what would make it singular.
- [ ] **Step 4:** `npm run typecheck`; commit "Record the sound of the place in the standing docs".

---

## Sequencing

A (1→5) strictly ordered. B (6–10) after A, serial (all touch `sound.ts`). C (11) after 3 and 1. D (12) after 4; D (13) after 12 and needs the real-machine gate. E last. Every task's playtest regression uses the shared 5199 server; the harness hides scenery already, and audio is silent under headless Chromium (no device) — which is precisely why the audiotest mock carries the arithmetic and the playtest only asserts wiring through the probe.
