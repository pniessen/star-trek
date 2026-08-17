/**
 * The audio layer, asserted in bare node against a fake WebAudio graph.
 *
 * Run with `node src/audio/selftest.mjs`. It emits the three modules it needs
 * with `tsc` the way `tools/campaigntest.mjs` does, into `node_modules` so that
 * bare specifiers still resolve, then drives them through a recording mock of
 * `AudioContext`.
 *
 * There are two reasons this exists rather than living in the playtest harness.
 * The first is that the contract in the header of `Synth.ts` — never throw,
 * never sound before a gesture, retire the whole layer on the first failure —
 * has only ever been true by inspection, and the machine it is written for is
 * one nobody here has: a browser with no audio device. A mock is the only way
 * to actually stand in front of that machine. The second is that envelope
 * shapes and partial counts are arithmetic, and arithmetic does not need a GPU.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
// Inside node_modules so that `three`, which the alert's neighbours drag in,
// still resolves by walking up, and so that nothing has to be gitignored.
const out = join(root, "node_modules", ".kobayashi-audiotest");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync(
  "npx",
  [
    "tsc",
    "src/audio/Synth.ts",
    "src/audio/sound.ts",
    "src/audio/radio.ts",
    "src/audio/formant.ts",
    "src/audio/acoustics.ts",
    "src/game/alert.ts",
    "--ignoreConfig",
    "--outDir",
    out,
    "--rootDir",
    "src",
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--moduleResolution",
    "bundler",
    "--lib",
    "ES2022,DOM,DOM.Iterable",
    "--skipLibCheck",
  ],
  { cwd: root, stdio: "inherit" },
);

// ── the fake graph ─────────────────────────────────────────────────────────

let nodes = [];
let compressors = 0;

function param(value = 0) {
  const p = {
    value,
    events: [],
    setValueAtTime(v, t) {
      p.events.push(["set", v, t]);
      return p;
    },
    linearRampToValueAtTime(v, t) {
      p.events.push(["lin", v, t]);
      return p;
    },
    exponentialRampToValueAtTime(v, t) {
      p.events.push(["exp", v, t]);
      return p;
    },
    setTargetAtTime(v, t, c) {
      p.events.push(["target", v, t, c]);
      return p;
    },
    cancelScheduledValues(t) {
      p.events.push(["cancel", t]);
      return p;
    },
  };
  return p;
}

function node(kind, extra = {}) {
  const n = {
    kind,
    out: [],
    disconnects: 0,
    connect(target) {
      n.out.push(target);
      return target;
    },
    disconnect() {
      n.disconnects++;
    },
    ...extra,
  };
  nodes.push(n);
  return n;
}

/** @param fail names of factory methods that should throw, and after how many calls */
function makeContext({ state = "running", fail = {} } = {}) {
  const counts = {};
  const guard = (name) => {
    counts[name] = (counts[name] ?? 0) + 1;
    if (fail[name] !== undefined && counts[name] > fail[name]) {
      throw new Error(`${name} unavailable`);
    }
  };
  const ctx = {
    state,
    currentTime: 1,
    sampleRate: 48000,
    destination: node("destination"),
    createGain() {
      guard("createGain");
      return node("gain", { gain: param(1) });
    },
    createBiquadFilter() {
      guard("createBiquadFilter");
      return node("biquad", { type: "lowpass", Q: param(1), frequency: param(350) });
    },
    createOscillator() {
      guard("createOscillator");
      return node("oscillator", {
        type: "sine",
        frequency: param(440),
        detune: param(0),
        started: null,
        stopped: null,
        onended: null,
        start(t) {
          this.started = t;
        },
        stop(t) {
          this.stopped = t;
        },
      });
    },
    createBufferSource() {
      guard("createBufferSource");
      return node("buffersource", {
        buffer: null,
        loop: false,
        playbackRate: param(1),
        started: null,
        stopped: null,
        onended: null,
        start(t, offset) {
          this.started = t;
          this.offset = offset;
        },
        stop(t) {
          this.stopped = t;
        },
      });
    },
    createStereoPanner() {
      guard("createStereoPanner");
      return node("panner", { pan: param(0) });
    },
    createWaveShaper() {
      guard("createWaveShaper");
      return node("waveshaper", { curve: null, oversample: "none" });
    },
    createConvolver() {
      guard("createConvolver");
      return node("convolver", { buffer: null, normalize: true });
    },
    createDynamicsCompressor() {
      compressors++;
      return node("compressor", {
        threshold: param(-24),
        knee: param(30),
        ratio: param(12),
        attack: param(0.003),
        release: param(0.25),
      });
    },
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { duration: length / rate, length, sampleRate: rate, getChannelData: () => data };
    },
    resume() {
      ctx.state = "running";
      return Promise.resolve();
    },
    suspend() {
      ctx.state = "suspended";
      return Promise.resolve();
    },
  };
  return ctx;
}

// ── harness ────────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

function ok(what, condition, detail = "") {
  if (condition) passed++;
  else failures.push(`${what}${detail ? ` — ${detail}` : ""}`);
}

function near(what, actual, expected, tolerance) {
  ok(what, Math.abs(actual - expected) <= tolerance, `got ${actual}, wanted ${expected}`);
}

let warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));

process.on("unhandledRejection", (error) => {
  failures.push(`unhandled rejection: ${error}`);
});

/** Everything created since the mark, which is one cue's worth of nodes. */
function mark() {
  return nodes.length;
}

/**
 * Reconstructs the voices scheduled since `from` by reading the envelopes back
 * off the gain nodes. `play` writes a fixed four-event shape, so this recovers
 * exactly the `VoiceSpec` that produced it.
 */
function voicesSince(from) {
  const fresh = nodes.slice(from);
  // `play` always opens with `setValueAtTime(0.0001, at)`, which is the one
  // signature the beds — smoothed with `setTargetAtTime` — never produce.
  const gains = fresh.filter(
    (n) => n.kind === "gain" && n.gain.events[0] && n.gain.events[0][0] === "set" && n.gain.events[0][1] === 0.0001,
  );
  return gains.map((gain) => {
    const events = gain.gain.events;
    const at = events[0][2];
    const peak = events.find((e) => e[0] === "lin");
    const held = events.find((e, i) => e[0] === "set" && i > 0);
    const end = events.find((e) => e[0] === "exp");
    const source = fresh.find((n) => n.out.includes(gain));
    const feeder = source && source.kind === "biquad" ? fresh.find((n) => n.out.includes(source)) : source;
    const swept = source && source.kind === "biquad" ? source.frequency : feeder && feeder.frequency;
    return {
      at,
      level: peak ? peak[1] : 0,
      attack: peak ? peak[1] && peak[2] - at : 0,
      hold: held ? held[2] - (peak ? peak[2] : at) : 0,
      end: end ? end[2] : at,
      kind: feeder && feeder.kind === "buffersource" ? "noise" : "tone",
      wave: feeder && feeder.type,
      filter: source && source.kind === "biquad" ? source.type : null,
      from: swept && swept.events[0] ? swept.events[0][1] : 0,
      to: swept && swept.events[1] ? swept.events[1][1] : null,
      panned: fresh.some((n) => n.kind === "panner" && gain.out.includes(n)),
    };
  });
}

// ── load ───────────────────────────────────────────────────────────────────

globalThis.window = {};
const { Synth } = await import(join(out, "audio/Synth.js"));
const { Sound } = await import(join(out, "audio/sound.js"));
const { AlertPulse } = await import(join(out, "game/alert.js"));

// A tiny, fixed phrase for `everyCue` below — `speak` is bench-level (Task 3),
// not yet a cue on `Sound`, so §1's gesture/no-device sections reach it
// through `s.synth.speak` directly rather than through a bank method.
const TEST_PHRASE = { syllables: [{ at: 0, length: 0.08, pitch: 160, f1: 500, f2: 1500, f3: 2500, level: 1 }], duration: 0.08 };

/** Every cue in the bank, called the way the game calls it. */
function everyCue(s) {
  s.listen(0, 0, 0);
  s.update({ threat: 400, hull: 0.6, thrust: 0.5, speed: 30, alive: true, docked: false, energy: 0.7, starved: false });
  s.synth.speak({ phrase: TEST_PHRASE, bus: "radio", level: 0.4, drive: 2, band: [300, 3400] });
  s.synth.setSpace({ tailSeconds: 0.3, tailCutoffHz: 3500, earlyReflections: [{ at: 0.02, gain: 0.4 }], wet: 0.25 });
  s.synth.spaceLevel(0.5);
  s.synth.setSpace(null);
  s.enterSector("rocks", true, 7, 3);
  s.insideComet(0.8);
  s.insideComet(0.1);
  s.phaser(true, 1);
  s.phaser(false, 0);
  s.torpedo(false);
  s.torpedo(true);
  s.hostileFire(3, 3);
  s.hostileFire(3, 3, "swarmer");
  s.hostileFire(3, 3, "sniper");
  s.hostileFire(3, 3, "brawler", true);
  s.lanceCharge(3, 3);
  s.mineArm(3, 3);
  s.mineTick(3, 3, 0.5);
  s.nearMiss(3, 3);
  s.impact(2, 2);
  s.thud(2, 2);
  s.kill(4, 4, 1.4, 2.6);
  s.shieldHit(1, 1, "port", 0.6);
  s.breach();
  s.multiplierHalved();
  s.multiplierTick(2.6);
  s.salvageTransfer(0, 1);
  s.approach(0.4, false);
  s.approach(0, true);
  s.mineBlast(5, 5);
  s.mineLay(6, 6);
  s.decloak(7, 7);
  s.ping(0.3, 60, 20);
  s.withdraw(6, 6);
  s.dispatch();
  s.wave(3);
  s.say("theirs", "wave", { doctrine: "raider" });
  s.hyperwarpCharge(2);
  s.hyperwarpAbort();
  s.hyperwarpArrive();
  s.scram();
  s.alertBeat(110, 4);
  s.hitStop(0.1);
  s.conditionChange(true);
  s.conditionChange(false);
  s.allyHail(8, 8);
  s.allyComms(8, 8);
  s.allyFire(8, 8);
  s.allyLost(8, 8);
  s.sectorClear();
  s.gate();
  s.tractor(1.35);
  s.hardDock();
  s.service(2);
  s.tally(4.5, 900);
  s.tally(1, 0);
  s.depart();
  s.death();
  s.deathPower(0.4);
  s.relayTick();
  s.panelRestore();
  s.silence();
  s.setPaused(true);
  s.setPaused(false);
  s.muted = true;
  s.muted = false;
}

// ── 1. the autoplay-gesture contract ───────────────────────────────────────
// The three states a machine can be in: no audio hardware at all, hardware
// that refuses to construct, and hardware that has not been gestured at yet.

{
  // No `AudioContext` on the page. A browser that has audio disabled entirely.
  delete globalThis.AudioContext;
  globalThis.window = {};
  nodes = [];
  warnings = [];
  const s = new Sound();
  let threw = null;
  try {
    s.start();
    everyCue(s);
  } catch (error) {
    threw = error;
  }
  ok("no AudioContext: nothing throws", threw === null, String(threw));
  ok("no AudioContext: nothing is created", nodes.length === 0, `${nodes.length} nodes`);
  ok("no AudioContext: silent, not noisy", warnings.length === 0, warnings.join("; "));
}

{
  // The constructor itself fails, which is what a machine with no output
  // device does.
  globalThis.AudioContext = function () {
    throw new Error("no audio device");
  };
  nodes = [];
  warnings = [];
  const s = new Sound();
  let threw = null;
  try {
    s.start();
    everyCue(s);
    s.start();
    everyCue(s);
  } catch (error) {
    threw = error;
  }
  ok("dead device: nothing throws", threw === null, String(threw));
  ok("dead device: reported exactly once", warnings.length === 1, `${warnings.length} warnings`);
  ok("dead device: reported as a warning", (warnings[0] ?? "").startsWith("audio disabled"));
}

{
  // Constructed but never gestured at: `state` stays "suspended" because
  // `resume()` is a no-op until a user activation. Nothing may be scheduled.
  const ctx = makeContext({ state: "suspended" });
  ctx.resume = () => Promise.resolve(); // the pre-gesture browser: refuses, quietly
  globalThis.AudioContext = function () {
    return ctx;
  };
  nodes = [];
  warnings = [];
  const s = new Sound();
  s.start();
  const built = mark();
  everyCue(s);
  ok("pre-gesture: the rig is built", built > 0);
  ok("pre-gesture: no voice is scheduled", voicesSince(built).length === 0, `${voicesSince(built).length} voices`);
  ok("pre-gesture: nothing failed", warnings.length === 0, warnings.join("; "));

  // And the same object, once the gesture lands.
  ctx.state = "running";
  const after = mark();
  s.phaser(true, 1);
  ok("post-gesture: voices appear", voicesSince(after).length > 0);
}

{
  // A rejected `resume()`, which is what a browser does when it decides the
  // keydown was not a user activation after all.
  const ctx = makeContext({ state: "suspended" });
  ctx.resume = () => Promise.reject(new Error("not allowed"));
  globalThis.AudioContext = function () {
    return ctx;
  };
  nodes = [];
  warnings = [];
  const s = new Sound();
  let threw = null;
  try {
    s.start();
    s.setPaused(false);
  } catch (error) {
    threw = error;
  }
  ok("rejected resume: nothing throws", threw === null, String(threw));
  await new Promise((r) => setTimeout(r, 10));
  // The unhandled-rejection listener above would have logged a failure.
  ok("rejected resume: no unhandled rejection", true);
}

{
  // The device disappears mid-run — a bluetooth speaker walking out of range.
  // The first failure has to retire the whole layer rather than raising sixty
  // times a second inside the frame loop.
  const ctx = makeContext({ fail: { createOscillator: 3 } });
  globalThis.AudioContext = function () {
    return ctx;
  };
  nodes = [];
  warnings = [];
  const s = new Sound();
  s.start();
  let threw = null;
  try {
    for (let frame = 0; frame < 200; frame++) everyCue(s);
  } catch (error) {
    threw = error;
  }
  ok("mid-run failure: nothing throws", threw === null, String(threw));
  ok("mid-run failure: retired after one report", warnings.length === 1, `${warnings.length} warnings`);
  const after = mark();
  s.phaser(true, 1);
  s.update({ threat: 9, hull: 1, thrust: 1, speed: 9, alive: true, docked: false, energy: 1, starved: false });
  ok("mid-run failure: stays retired", voicesSince(after).length === 0);
}

{
  // A browser with everything else but no `ConvolverNode` — `setSpace` must
  // retire the layer exactly like any other missing factory, not throw out
  // of the frame loop the way an unguarded call would.
  const ctx = makeContext({ fail: { createConvolver: 0 } });
  globalThis.AudioContext = function () {
    return ctx;
  };
  nodes = [];
  warnings = [];
  const s = new Sound();
  s.start();
  let threw = null;
  try {
    s.synth.setSpace({ tailSeconds: 0.3, tailCutoffHz: 3500, earlyReflections: [], wet: 0.25 });
  } catch (error) {
    threw = error;
  }
  ok("no createConvolver: nothing throws", threw === null, String(threw));
  ok("no createConvolver: reported exactly once", warnings.length === 1, `${warnings.length} warnings`);
  ok("no createConvolver: reported as a warning", (warnings[0] ?? "").startsWith("audio disabled"));
}

// ── 2. the master chain ────────────────────────────────────────────────────

let chain;
{
  const ctx = makeContext();
  globalThis.AudioContext = function () {
    return ctx;
  };
  nodes = [];
  warnings = [];
  compressors = 0;
  const synth = new Synth();
  synth.start();
  chain = { nodes: [...nodes], ctx };

  ok("no compressor: the 6 ms lookahead is gone", compressors === 0);

  const shaper = nodes.find((n) => n.kind === "waveshaper");
  ok("a shaper stands in for it", shaper !== undefined);
  ok("the shaper does not oversample", shaper && shaper.oversample === "none", "oversampling reintroduces latency");

  const dc = nodes.find((n) => n.kind === "biquad" && n.type === "highpass");
  ok("a DC highpass exists", dc !== undefined);
  ok(
    "the highpass sits at 20-25 Hz",
    dc && dc.frequency.value >= 20 && dc.frequency.value <= 25,
    dc && String(dc.frequency.value),
  );

  // The curve, checked as a transfer function rather than as a table.
  const curve = shaper.curve;
  const trim = nodes.find((n) => n.kind === "gain" && n.out.includes(shaper));
  ok("the shaper is fed through a trim", trim !== undefined);
  const ceiling = trim ? 1 / trim.gain.value : 0;
  near("the trim buys headroom above unity", ceiling, 4, 1e-9);

  // Linear interpolation between table entries, because that is what the spec
  // requires of an implementation and the table is only as good as that makes it.
  const transfer = (u) => {
    const x = Math.max(-1, Math.min(1, u / ceiling));
    const at = ((x + 1) / 2) * (curve.length - 1);
    const i = Math.min(curve.length - 2, Math.floor(at));
    return curve[i] + (curve[i + 1] - curve[i]) * (at - i);
  };
  near("transfer is odd through zero", transfer(0), 0, 1e-6);
  near("identity at -40 dBFS", transfer(0.01), 0.01, 1e-4);
  near("identity to 1% at -15 dBFS", transfer(0.17) / 0.17, 1, 0.01);
  ok("never reaches full scale", Math.abs(transfer(4)) < 1 && Math.abs(transfer(400)) < 1);
  let monotonic = true;
  for (let i = 1; i < curve.length; i++) if (curve[i] <= curve[i - 1]) monotonic = false;
  ok("monotonic, so it cannot fold", monotonic);
  near("tanh, exactly", transfer(2), Math.tanh(2), 1e-3);
}

// ── 3. static budgets: each bus refuses its own surplus, never another's ──
{
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();
  s.listen(0, 0, 0);
  // The cap counts cues, not voices (owner's ruling, 2026-08-16 — no
  // exceptions: `phaser` and `kill` are grouped exactly like every other
  // multi-layer cue). A `hit` phaser is two layers — the zap and its return
  // blip — sharing one group, so the weapon bus's cap of 3 admits 3 phaser
  // *cues*, which is 6 voices, not 3.
  let from = mark();
  for (let i = 0; i < 40; i++) s.phaser(true, 1);
  const phaserLayers = 2; // zap + return blip, since hit === true
  ok(
    "the weapon bus is capped at 3 cues, not 3 voices",
    voicesSince(from).length === 3 * phaserLayers,
    `${voicesSince(from).length}, wanted ${3 * phaserLayers}`,
  );
  from = mark();
  for (let i = 0; i < 40; i++) s.hostileFire(3, 3);
  ok("the hostile bus is capped at 4 (hostileFire is a single voice, ungrouped)", voicesSince(from).length === 4, `${voicesSince(from).length}`);
  from = mark();
  for (let i = 0; i < 40; i++) s.kill(4, 4, 1);
  const killVoices = voicesSince(from).length;
  const killLayers = 3; // lowpass body + sine tone + highpass crack, one group
  ok(
    "the impact bus is capped at 4 cues, not 4 voices",
    killVoices === 4 * killLayers,
    `${killVoices}, wanted ${4 * killLayers}`,
  );
  const cancelled = nodes.slice(from).some((n) => n.kind === "gain" && n.gain.events.some((e) => e[0] === "cancel"));
  ok("nothing already sounding was cut", !cancelled);

  // A slot frees once its voices are reaped. Fill the (so-far untouched)
  // panel bus to its cap of 2 with two distinct groups — one of them two
  // layers, to confirm a multi-layer group still frees as a unit — then a
  // third, separate group is refused; advance the clock past every filling
  // voice's own `end`, and the freed slot admits a fresh group again.
  const fillA = s.synth.group();
  s.synth.play({ bus: "panel", group: fillA, freq: 500, level: 0.1, decay: 0.05 });
  s.synth.play({ bus: "panel", group: fillA, freq: 501, level: 0.1, decay: 0.05 });
  const fillB = s.synth.group();
  s.synth.play({ bus: "panel", group: fillB, freq: 600, level: 0.1, decay: 0.05 });
  const blockedFrom = mark();
  const blocked = s.synth.group();
  s.synth.play({ bus: "panel", group: blocked, freq: 700, level: 0.1, decay: 0.05 });
  ok("a bus at its cap refuses a third, separate group", voicesSince(blockedFrom).length === 0, `${voicesSince(blockedFrom).length}`);
  ctx.currentTime += 1; // past every filling voice's decay
  const freedFrom = mark();
  const freed = s.synth.group();
  s.synth.play({ bus: "panel", group: freed, freq: 800, level: 0.1, decay: 0.05 });
  ok("the slot frees once its voices are reaped", voicesSince(freedFrom).length === 1, `${voicesSince(freedFrom).length}`);
  // Duck: a smoothed dip on one bus that recovers.
  //
  // Bus gains are identified structurally rather than by a name the mock does
  // not carry: `Synth.build` connects every bus gain straight to the master
  // gain, and the master gain straight to the DC-offset highpass, so "a gain
  // whose `.out` contains the master" and "the master is the gain whose `.out`
  // contains the DC biquad" together pick out exactly the nine bus gains and
  // nothing upstream or downstream of them (not the per-voice gains, which
  // route through a bus gain rather than into it; not the master itself).
  const master = nodes.find((n) => n.kind === "gain" && n.out.some((o) => o.kind === "biquad" && o.type === "highpass"));
  const busGains = nodes.filter((n) => n.kind === "gain" && n.out.includes(master));
  const beforeEvents = busGains.map((g) => g.gain.events.length);
  s.synth.duck("weapon", 6, 0.4);
  const changed = busGains.filter((g, i) => g.gain.events.length > beforeEvents[i]);
  ok("duck writes a dip and a recovery on exactly one bus", changed.length === 1 && changed[0].gain.events.length - beforeEvents[busGains.indexOf(changed[0])] >= 2, `${changed.length} buses touched`);

  // Groups: the cap counts cues, not layers (ruling, 2026-08-16 — see the
  // report). `alertBeat`'s own partials share one budget slot, so a full
  // klaxon's four layers all fit under the alert bus's cap of 1 — but a
  // *second*, distinct beat finds the bus already occupied and is refused
  // wholesale, not thinned.
  from = mark();
  s.alertBeat(110, 4);
  const firstBeat = voicesSince(from).length;
  const secondFrom = mark();
  s.alertBeat(220, 4);
  const secondBeat = voicesSince(secondFrom).length;
  ok("a klaxon's four partials share one slot and all sound", firstBeat === 4, `${firstBeat}`);
  ok(
    "a second beat in the same instant is refused entirely (8 voices requested, 4 scheduled)",
    secondBeat === 0,
    `${secondBeat}`,
  );
}

// ── 4. the alert escalates by spectrum, never by level ─────────────────────

{
  const pulse = new AlertPulse();
  const beats = (condition, urgency, seconds) => {
    const out = [];
    for (let t = 0; t < seconds; t += 1 / 60) {
      if (pulse.update(1 / 60, condition, urgency)) {
        out.push({ f: pulse.frequency, c: pulse.components, on: pulse.sounding });
      }
    }
    return out;
  };

  const calm = beats("red", 0, 6);
  pulse.reset();
  pulse.update(0, "green", 0);
  const fierce = beats("red", 1, 6);

  ok("the note length never changes", calm.every((b) => b.on === fierce[0].on), "Asteroids shortens the gap, not the note");
  ok("the gap shrinks with urgency", fierce.length > calm.length, `${calm.length} vs ${fierce.length} beats`);
  // Averaged, because the two-pitch alternation means any single beat could be
  // either half of the toggle.
  const mean = (b) => b.reduce((a, x) => a + x.f, 0) / b.length;
  ok("the pitch rises with urgency", mean(fierce) > mean(calm), `${mean(calm)} then ${mean(fierce)}`);
  ok("two pitches alternate", calm.length > 1 && calm[0].f !== calm[1].f);
  ok("a calm red is plain", calm.every((b) => b.c <= 2), `components ${calm.map((b) => b.c).join(",")}`);
  ok("a fierce red is rough", fierce.some((b) => b.c === 4));

  // Patterson's decay: hold it unchanged and it loses partials, not level.
  pulse.reset();
  const long = beats("red", 1, 20);
  const early = long.slice(0, 3).map((b) => b.c);
  const late = long.slice(-3).map((b) => b.c);
  ok("an unanswered alarm backs off", Math.max(...late) < Math.max(...early), `${early} then ${late}`);

  // And comes straight back when the situation changes.
  pulse.update(1 / 60, "yellow", 1);
  const back = beats("red", 1, 4);
  ok("news restores it", back.some((b) => b.c === 4));

  pulse.update(1 / 60, "green", 0);
  ok("green is silent", pulse.sounding === 0 && pulse.components === 1);
}

{
  // `alertBeat` and `conditionChange` now live on the `alert` bus, capped at
  // 1 (Task 1: static per-bus budgets) — deliberately the tightest budget in
  // the bank, since only one alert condition is ever live. Both cues build
  // several simultaneous voices (up to four partials for a klaxon beat; two
  // or three pulses for a condition whoop) — and, per the ruling that the cap
  // counts *cues*, not layers (2026-08-16 — see the report), both now open
  // with `this.synth.group()` so their own partials share the bus's one slot
  // rather than compete for it. A *separate* beat still only gets the slot
  // once the previous one has ended, which the mock's frozen clock does not
  // model on its own — a fresh `Sound` per call stands in for the real gap
  // between distinct alert events (`AlertPulse` never re-fires mid-decay),
  // isolating what this section actually tests: one beat's own layers.
  const beat = (components) => {
    const s = new Sound();
    s.start();
    const from = mark();
    s.alertBeat(110, components);
    return voicesSince(from);
  };
  const plain = beat(1);
  const rough = beat(2);
  const klaxon = beat(4);

  ok("one partial when plain", plain.length === 1, `${plain.length}`);
  ok("two when roughened", rough.length === 2, `${rough.length}`);
  ok("four at the top", klaxon.length === 4, `${klaxon.length}`);
  ok(
    "the fundamental's level never moves",
    plain[0].level === rough[0].level && rough[0].level === klaxon[0].level,
    `${plain[0].level} / ${rough[0].level} / ${klaxon[0].level}`,
  );
  ok("the fundamental's pitch never moves", plain[0].from === klaxon[0].from);
  near("the second is a minor second up", rough[1].from / rough[0].from, 1.06, 0.005);
  const offsets = klaxon.slice(2).map((v) => v.from - klaxon[0].from);
  ok("the sidebands straddle it", offsets.includes(-40) && offsets.includes(40), offsets.join(","));
  ok(
    "every partial rises over 20 ms",
    [plain, rough, klaxon].flat().every((v) => v.attack >= 0.0199),
    "Patterson: under 10 ms is a startle reflex",
  );
  ok("urgency adds energy rather than gain", klaxon.reduce((a, v) => a + v.level, 0) > plain[0].level);

  const whoop = (red) => {
    const s = new Sound();
    s.start();
    const from = mark();
    s.conditionChange(red);
    return voicesSince(from);
  };
  const yellow = whoop(false);
  const red = whoop(true);
  const tones = (v) => v.filter((x) => x.kind === "tone");
  ok("yellow is two pulses", tones(yellow).length === 2, `${tones(yellow).length}`);
  ok("red is three", tones(red).length === 3, `${tones(red).length}`);
  ok(
    "they do not share a repetition rate",
    tones(red)[1].at - tones(red)[0].at !== tones(yellow)[1].at - tones(yellow)[0].at,
    "Patterson: rhythm distinguishes, timbre does not",
  );
  near(
    "and they sit at the same level",
    Math.max(...tones(red).map((v) => v.level)),
    Math.max(...tones(yellow).map((v) => v.level)),
    1e-9,
  );
  const rising = (v) => v.every((x, i) => i === 0 || x.level >= v[i - 1].level);
  ok("red rises within the burst", rising(tones(red)), "the first pulse is the quietest");
  ok("yellow rises within the burst", rising(tones(yellow)));
}

// ── 5. the two weapons, told apart ─────────────────────────────────────────

{
  const ctx = makeContext();
  globalThis.AudioContext = function () {
    return ctx;
  };
  nodes = [];
  const s = new Sound();
  s.start();

  // The weapon bus is capped at 3 (Task 1). A real firefight spaces
  // successive shots out — the 0.16 s cooldown alone guarantees it — so each
  // `shot()` call advances the mock's clock past every voice a phaser can
  // possibly still be holding open before scheduling the next one; this
  // keeps the bus's own single-call budget (never more than 2 voices at
  // once, for a hit) the only thing under test, rather than an artefact of
  // the mock's frozen clock. `phaserFlip` lives on `s`, not on the clock, so
  // the alternating-pitch tests below are unaffected.
  const shot = (hit, reach) => {
    ctx.currentTime += 1;
    const from = mark();
    s.phaser(hit, reach);
    return voicesSince(from);
  };
  const miss = shot(false, 1);
  const hit = shot(true, 1);
  const far = shot(false, 0);

  ok("a miss is one voice", miss.length === 1, `${miss.length}`);
  ok("a hit adds a return, not a level", hit.length === 2 && hit[0].level === miss[0].level);
  ok("no noise layer under the zap", miss[0].kind === "tone", "sfxr's laser preset has none");
  ok("the zap is harsh", miss[0].wave === "square");
  ok(
    "the whole shot clears the 0.16 s repeat",
    hit.every((v) => v.end - hit[0].at < 0.16),
    `${(Math.max(...hit.map((v) => v.end)) - hit[0].at).toFixed(3)} s`,
  );
  ok("and clears the 110 ms target", miss[0].end - miss[0].at <= 0.11);
  ok("it stops rather than fades", miss[0].end - (miss[0].at + miss[0].attack + miss[0].hold) <= 0.02);
  ok("it never touches the bass", miss[0].to >= 700, `${miss[0].to}`);
  ok("range shortens the shot", far[0].end - far[0].at < miss[0].end - miss[0].at);
  ok("range shallows the sweep", far[0].to / far[0].from > miss[0].to / miss[0].from);

  const a = shot(false, 1);
  const b = shot(false, 1);
  near("consecutive shots are a minor third apart", Math.max(a[0].from, b[0].from) / Math.min(a[0].from, b[0].from), 1.19, 0.06);
  const c = shot(false, 1);
  const e = shot(false, 1);
  ok("and no two are identical", a[0].from !== c[0].from && b[0].from !== e[0].from, "the jitter is doing nothing");

  // `torpedo` fires all four of its layers at the same instant; grouped
  // (Task 1 fix-up, 2026-08-16 — the cap counts cues, not layers), they share
  // one slot on the weapon bus, well under its cap of 3, so the shell keeps
  // its full four layers. The clock still advances between distinct reports —
  // `torpedo(false)` then `torpedo(true)` are two separate shots, not one
  // compound cue, so each gets a clean bus the way spaced-out real shots would.
  ctx.currentTime += 1;
  const from = mark();
  s.torpedo(false);
  const shell = voicesSince(from);
  ctx.currentTime += 1;
  const lastFrom = mark();
  s.torpedo(true);
  const empty = voicesSince(lastFrom);

  ok("the shell is four layers", shell.length === 4, `${shell.length}`);
  ok("the punch is first and instant", shell[0].attack <= 0.001, `${shell[0].attack}`);
  ok("the punch is the loudest of them", shell[0].level === Math.max(...shell.map((v) => v.level)));
  ok("it ends up under 120 Hz", shell.some((v) => v.kind === "tone" && v.to !== null && v.to < 120));
  ok("the last one says so", empty.length === shell.length + 1);

  // The point of the exercise: the two weapons share no register.
  const phaserBand = [Math.min(miss[0].from, miss[0].to), Math.max(miss[0].from, miss[0].to)];
  const shellTone = shell.find((v) => v.kind === "tone");
  ok(
    "the two weapons do not overlap in band",
    Math.max(shellTone.from, shellTone.to) < phaserBand[0],
    `shell tops at ${Math.max(shellTone.from, shellTone.to)}, phaser bottoms at ${phaserBand[0]}`,
  );
  ok(
    "one is pitched, the other percussive",
    miss.every((v) => v.kind === "tone") && shell.filter((v) => v.kind === "noise").length === 3,
  );
}

// ── 6. the near miss ────────────────────────────────────────────────────────
// A shot that swept past but not in — quieter than hostileFire, panned the
// same way, and gone entirely once it is too far off to hear.

{
  const ctx = makeContext();
  globalThis.AudioContext = function () {
    return ctx;
  };
  nodes = [];
  const s = new Sound();
  s.start();
  s.listen(0, 0, 0);

  const near = mark();
  s.nearMiss(5, 5);
  const close = voicesSince(near);

  ok("a near miss is one voice", close.length === 1, `${close.length}`);
  ok("it is a noise sweep, not a tone", close[0].kind === "noise");
  ok("it rides a bandpass filter — the weapon bus's own shape", close[0].filter === "bandpass");
  ok("it sweeps down from 1900 Hz", close[0].from === 1900, `${close[0].from}`);
  ok("and lands at 420 Hz — the doppler-past character", close[0].to === 420, `${close[0].to}`);
  ok("it is placed, like every other positioned cue", close[0].panned);
  ok("quieter than a hit landing", close[0].level < 0.12, `${close[0].level}`);

  const far = mark();
  s.nearMiss(400, 400);
  const gone = voicesSince(far);
  ok("out of earshot, it plays nothing", gone.length === 0, `${gone.length}`);
}

// ── 7. withdrawal ────────────────────────────────────────────────────────────
// A hostile clearing the fight, not joining it — `hostileFire`'s own shape
// run backwards, so a departure cannot be mistaken for a quieter threat.

{
  const ctx = makeContext();
  globalThis.AudioContext = function () {
    return ctx;
  };
  nodes = [];
  const s = new Sound();
  s.start();
  s.listen(0, 0, 0);

  const near = mark();
  s.withdraw(6, 6);
  const close = voicesSince(near);

  ok("a withdrawal is one voice", close.length === 1, `${close.length}`);
  ok("it is a tone, not noise", close[0].kind === "tone");
  ok("it is a sawtooth, on the weapon bus's own timbre", close[0].wave === "sawtooth");
  ok("it rises from 300 Hz", close[0].from === 300, `${close[0].from}`);
  ok("...to 640 Hz — the opposite motion of hostileFire's fall", close[0].to === 640, `${close[0].to}`);
  ok("it is placed, like every other positioned cue", close[0].panned);
  ok("quieter than a hit landing", close[0].level < 0.12, `${close[0].level}`);

  const far = mark();
  s.withdraw(400, 400);
  const gone = voicesSince(far);
  ok("out of earshot, it plays nothing", gone.length === 0, `${gone.length}`);
}

// ── 8. the fm voice: a modulator into the carrier's frequency ──────────────

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

  // `index: 0` would otherwise schedule an exponential ramp starting from a
  // literal 0, which real WebAudio throws on — and that throw lands inside
  // `play`'s try/catch, retiring the whole audio layer for the session. The
  // depth gain's own initial value must be floored the same way the voice
  // envelope's is.
  const zeroFrom = mark();
  synth.play({ kind: "fm", bus: "impact", freq: 220, index: 0, decay: 0.2, level: 0.2 });
  const zeroFresh = nodes.slice(zeroFrom);
  const zeroOscs = zeroFresh.filter((n) => n.kind === "oscillator");
  const zeroCarrier = zeroOscs.find((o) =>
    zeroFresh.some((g) => g.kind === "gain" && o.out.includes(g) && g.gain.events[0] && g.gain.events[0][1] === 0.0001),
  );
  const zeroModulator = zeroOscs.find((o) => o !== zeroCarrier);
  const zeroDepth = zeroFresh.find((g) => g.kind === "gain" && zeroModulator && zeroModulator.out.includes(g));
  ok(
    "index: 0 floors the depth gain instead of starting an exponential ramp from 0",
    zeroDepth && zeroDepth.gain.events[0] && zeroDepth.gain.events[0][1] >= 0.0001,
    zeroDepth ? `${zeroDepth.gain.events[0][1]}` : "no depth gain found",
  );
}

// ── 9. the formant voice speaks a phrase on the audio clock ────────────────

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
  // Placeholder promoted to a real assertion — §17, Task 11's own radio
  // section, is where the budget actually gets exercised, against `Radio`
  // rather than a bare `synth.speak` loop.

  // Task 11 needs a squelch-only phrase (the Shroud's commit) — `speak` must
  // accept zero syllables gracefully rather than requiring `composePhrase`
  // to support `syllablesMin === 0`.
  const zeroPhrase = { syllables: [], duration: 0 };
  const from2 = mark();
  synth.speak({ phrase: zeroPhrase, bus: "radio", level: 0.4, drive: 2, band: [300, 3400] });
  const fresh2 = nodes.slice(from2);
  ok("a zero-syllable phrase still builds two squelch bursts", fresh2.filter((n) => n.kind === "buffersource").length === 2, "");
  const bandpasses2 = fresh2.filter((n) => n.kind === "biquad" && n.type === "bandpass");
  const gate2 = fresh2.find((n) => n.kind === "gain" && bandpasses2.length > 0 && bandpasses2.every((bp) => bp.out.includes(n)));
  ok(
    "and opens no syllable gate",
    !gate2 || !gate2.gain.events.some((e) => e[0] === "lin"),
    "the gate ramped despite no syllables to voice",
  );
}

// ── 10. the space: a computed impulse on a send ────────────────────────────

{
  const { renderImpulse } = await import(join(out, "audio/acoustics.js"));
  let seed = 3; const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rocks = renderImpulse({ tailSeconds: 0.5, tailCutoffHz: 4000, earlyReflections: [{ at: 0.05, gain: 0.5 }, { at: 0.12, gain: 0.3 }], wet: 0.3 }, 48000, rng);
  ok("the impulse has the tail's length", rocks.length === 24000, `${rocks.length}`);
  ok("early reflections are discrete peaks", Math.abs(rocks[Math.round(0.05 * 48000)]) > 0.3, "");
  ok("peak is normalised under 0.9", Math.max(...rocks.map(Math.abs)) <= 0.9, "");
  const bare = renderImpulse({ tailSeconds: 0.05, tailCutoffHz: 8000, earlyReflections: [], wet: 0 }, 48000, rng);
  ok("a bare room is nearly nothing", bare.length <= 2400, "");

  // `noiseOnly` (the comet's tail): flat, and no discrete bounces even if
  // some are supplied — a room in name only.
  const mist = renderImpulse(
    { tailSeconds: 0.3, tailCutoffHz: 2000, earlyReflections: [{ at: 0.01, gain: 0.9 }], wet: 0.4, noiseOnly: true },
    48000,
    rng,
  );
  const early = Math.max(...mist.slice(0, mist.length / 3).map(Math.abs));
  const late = Math.max(...mist.slice(-Math.floor(mist.length / 3)).map(Math.abs));
  ok("noiseOnly does not decay: the tail end is as loud as the start", late > early * 0.5, `${early} then ${late}`);
  ok(
    "noiseOnly plants no discrete reflection despite one being supplied",
    Math.abs(mist[Math.round(0.01 * 48000)]) < 0.9,
    `${mist[Math.round(0.01 * 48000)]}`,
  );

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

  // Sends: every bus send gain is a gain whose out includes the convolver.
  const sends = nodes.filter((n) => n.kind === "gain" && n.out.includes(conv));
  ok("sends exist per bus", sends.length >= 6, `${sends.length}`);

  // Bed and radio are pinned dry (the reactor is inside the ship, the radio
  // is a carrier — neither is in the room) — identified by `Bus`, through
  // `sendLevels()`, rather than by node-graph structure the mock cannot
  // label. Every other send opens to `design.wet` (0.3, at spaceLevel 1).
  const levels = synth.sendLevels();
  ok("bed's send is always dry", levels.bed === 0, `${levels.bed}`);
  ok("radio's send is always dry", levels.radio === 0, `${levels.radio}`);
  ok(
    "every other bus opens to design.wet",
    (["weapon", "impact", "hostile", "mechanism", "panel", "alert", "echo"]).every((b) => Math.abs(levels[b] - 0.3) < 1e-9),
    JSON.stringify(levels),
  );

  // The threat duck: `spaceLevel` scales every open send, never the pinned
  // two (0 × anything is still 0).
  synth.spaceLevel(0.5);
  const ducked = synth.sendLevels();
  ok("spaceLevel scales the open sends", Math.abs(ducked.weapon - 0.15) < 1e-9, `${ducked.weapon}`);
  ok("...and leaves the pinned two at 0", ducked.bed === 0 && ducked.radio === 0);

  // `setSpace(null)`: every send closes, the pinned two included (already 0).
  synth.setSpace(null);
  const closed = synth.sendLevels();
  ok(
    "setSpace(null) closes every send",
    Object.values(closed).every((v) => v === 0),
    JSON.stringify(closed),
  );

  // The convolver's own output goes straight to master, never back into a
  // bus — routing it into a bus would be feedback.
  const master = nodes.find((n) => n.kind === "gain" && n.out.some((o) => o.kind === "biquad" && o.type === "highpass"));
  ok("the convolver feeds master, not a bus", conv.out.length === 1 && conv.out[0] === master, "");
}

// ── 11. hit-stop marks the beds ─────────────────────────────────────────────

{
  // `Bed.dip` itself, built directly with a `tone` spec so both the filter
  // and (unlike the noise-kind engine bed below) the pitch params exist to
  // assert against.
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const synth = new Synth();
  synth.start();

  const from = mark();
  const bed = synth.bed({ kind: "tone", wave: "sawtooth", filter: "lowpass", q: 4, ratio: 1.5 });
  bed.set(0.4, 220, 900, 0, 0);
  const fresh = nodes.slice(from);
  const filterNode = fresh.find((n) => n.kind === "biquad");
  // The bed also builds an LFO oscillator (for the tremolo), which `dip`
  // never touches — so the pitch oscillators are the ones that feed the
  // filter, not merely every oscillator in the graph.
  const pitchOscillators = fresh.filter((n) => n.kind === "oscillator" && n.out.includes(filterNode));
  ok(
    "set() at a live level builds a filter and two pitch oscillators",
    filterNode !== undefined && pitchOscillators.length === 2,
    `${pitchOscillators.length}`,
  );

  const filterEventsBefore = filterNode.frequency.events.length;
  const pitchEventsBefore = pitchOscillators[0].frequency.events.length;

  bed.dip(0.12);

  ok(
    "dip writes at least a dip-and-recover pair to the filter",
    filterNode.frequency.events.length - filterEventsBefore >= 2,
    `${filterNode.frequency.events.length - filterEventsBefore}`,
  );
  ok(
    "dip writes the same pair to a pitch",
    pitchOscillators[0].frequency.events.length - pitchEventsBefore >= 2,
    `${pitchOscillators[0].frequency.events.length - pitchEventsBefore}`,
  );

  const filterEvents = filterNode.frequency.events;
  const dipEvent = filterEvents[filterEvents.length - 2];
  const recoverEvent = filterEvents[filterEvents.length - 1];
  ok("the dip drops the filter to 0.55 of its last target", Math.abs(dipEvent[1] - 900 * 0.55) < 1e-6, `${dipEvent[1]}`);
  ok(
    "...and recovers to the target it was already heading for, not a hardcoded one",
    Math.abs(recoverEvent[1] - 900) < 1e-6,
    `${recoverEvent[1]}`,
  );
  ok("the dip is fast and the recovery is slower", dipEvent[3] < recoverEvent[3], `${dipEvent[3]} vs ${recoverEvent[3]}`);

  // A bed that never reached a live level never built nodes — `dip` on one is
  // a guarded no-op, the same contract `set` itself keeps.
  const silent = synth.bed({ kind: "tone" });
  silent.dip(0.1);
  ok("dip on a bed with no nodes does not throw", true);
}

{
  // The wiring: `sound.hitStop` marks every live bed it owns. Both the
  // engine and the reactor are live through `update()` now — the alert bed
  // is still held at silence by design (see `Sound.update`'s own comment) —
  // so this exercises the filter side of the dip on both, plus the
  // reactor's pitch side (a noise bed, the engine's own kind, has no pitch
  // params at all).
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();
  s.update({ threat: 400, hull: 0.6, thrust: 0.5, speed: 30, alive: true, docked: false, energy: 1, starved: false });

  const lowpassFilters = nodes.filter((n) => n.kind === "biquad" && n.type === "lowpass");
  ok(
    "update() under thrust builds the engine's and the reactor's filters",
    lowpassFilters.length === 2,
    `${lowpassFilters.length}`,
  );
  // Structural, not order-dependent: the engine is noise-kind (fed by a
  // buffer source), the reactor is tone-kind (fed by two oscillators).
  const engineFilter = lowpassFilters.find((f) => nodes.some((n) => n.kind === "buffersource" && n.out.includes(f)));
  const reactorFilter = lowpassFilters.find((f) => f !== engineFilter);
  ok("the engine's filter is fed by noise", engineFilter !== undefined);
  ok("the reactor's filter is fed by something else — the two oscillators", reactorFilter !== undefined);

  const engineBefore = engineFilter.frequency.events.length;
  const reactorBefore = reactorFilter.frequency.events.length;
  const reactorOscillators = nodes.filter((n) => n.kind === "oscillator" && n.out.includes(reactorFilter));
  const reactorPitchBefore = reactorOscillators.map((o) => o.frequency.events.length);

  s.hitStop(0.12);

  ok(
    "hitStop writes a dip-and-recover pair to the engine's filter",
    engineFilter.frequency.events.length - engineBefore >= 2,
    `${engineFilter.frequency.events.length - engineBefore}`,
  );
  ok(
    "hitStop writes a dip-and-recover pair to the reactor's filter too",
    reactorFilter.frequency.events.length - reactorBefore >= 2,
    `${reactorFilter.frequency.events.length - reactorBefore}`,
  );
  ok(
    "...and to the reactor's own pitch oscillators",
    reactorOscillators.every((o, i) => o.frequency.events.length - reactorPitchBefore[i] >= 2),
  );

  // The silent alert bed rides along in the same call and never throws.
  ok("hitStop with a never-built bed in the mix does not throw", true);
}

{
  // The regression this whole section exists to catch: `main.ts` calls
  // `session.update` (which reaches `hitStop.strike` → `sound.hitStop` →
  // `dip`) and then `sound.update` (→ `bed.set`) in the same synchronous
  // frame, at the same `ctx.currentTime` — no audio time passes between
  // them. Without a dip window, `set`'s own every-frame `setTargetAtTime`
  // back to the live scene's cutoff/pitch would silently re-arm over the
  // dip's before either event ever had a chance to be heard.
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const synth = new Synth();
  synth.start();

  const from = mark();
  const bed = synth.bed({ kind: "tone", wave: "sawtooth", filter: "lowpass", q: 4, ratio: 1.5 });
  bed.set(0.4, 220, 900, 0, 0);
  const fresh = nodes.slice(from);
  const filterNode = fresh.find((n) => n.kind === "biquad");

  bed.dip(0.12);
  const afterDip = filterNode.frequency.events.length;
  const dipsLastEvent = filterNode.frequency.events[afterDip - 1];

  // Production order: the very next call, at the very same `ctx.currentTime`
  // — no `ctx.currentTime` advance, exactly like the same-frame collision.
  bed.set(0.4, 220, 900, 0, 0);

  ok(
    "set() immediately after dip, same instant, writes no new filter event",
    filterNode.frequency.events.length === afterDip,
    `${filterNode.frequency.events.length} vs ${afterDip}`,
  );
  ok(
    "...the dip's own last scheduled event still stands, untouched",
    filterNode.frequency.events[filterNode.frequency.events.length - 1] === dipsLastEvent,
  );

  // Once the window has actually closed, `set` is free to write again — the
  // ordinary glide-to-current-target path, not `dip`'s.
  ctx.currentTime += 1;
  const beforeReopen = filterNode.frequency.events.length;
  bed.set(0.4, 220, 900, 0, 0);
  ok(
    "...and once the dip window closes, set() writes normally again",
    filterNode.frequency.events.length > beforeReopen,
    `${filterNode.frequency.events.length} vs ${beforeReopen}`,
  );
}

// ── 12. the reactor bed breathes with the reserve ───────────────────────────
{
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();
  s.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: true, docked: false, energy: 1, starved: false });

  const lowpassFilters = nodes.filter((n) => n.kind === "biquad" && n.type === "lowpass");
  // The engine is live at rest too (its idle level is a nonzero constant),
  // so the reactor's filter is picked out structurally: it is the one fed
  // by two oscillators, the beat itself, where the engine's is fed by noise.
  const reactorFilter = lowpassFilters.find(
    (f) => nodes.filter((n) => n.kind === "oscillator" && n.out.includes(f)).length === 2,
  );
  ok("update() builds the reactor's own filter", reactorFilter !== undefined);
  const reactorOscillators = nodes.filter((n) => n.kind === "oscillator" && n.out.includes(reactorFilter));
  ok(
    "...fed by exactly two oscillators, the 58 Hz beat",
    reactorOscillators.length === 2,
    `${reactorOscillators.length}`,
  );

  const [base, detuned] = reactorOscillators.map((o) => o.frequency.events[0][1]);
  near("the fundamental sits at 58 Hz at full energy", base, 58, 0.5);
  near("the second oscillator sits at 58 × 1.0069 Hz — the ~0.4 Hz beat", detuned, 58 * 1.0069, 0.5);

  // Starved, reserve nearly empty: the pitch target halves outright, rather
  // than merely continuing the same droop curve toward zero.
  s.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: true, docked: false, energy: 0.05, starved: true });
  const baseStarved = reactorOscillators[0].frequency.events.at(-1)[1];
  near("starved halves the reactor's pitch target", baseStarved, 29, 0.5);

  // The relay tick: a sparse click on the panel bus — the bed bus's cap of 2
  // is already spent on the engine and the reactor themselves — while
  // starved. Advance the mock's audio clock, not real time, since the tick
  // is scheduled off `ctx.currentTime` for the same reason `Bed.dip` is.
  const panelBus = s.synth.context.buses.panel;
  const from = mark();
  for (let i = 0; i < 6; i++) {
    ctx.currentTime += 0.5;
    s.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: true, docked: false, energy: 0.05, starved: true });
  }
  const ticks = nodes
    .slice(from)
    .filter(
      (n) =>
        n.kind === "biquad" &&
        n.type === "highpass" &&
        n.frequency.events[0] &&
        n.frequency.events[0][1] === 3200 &&
        n.out.some((g) => g.kind === "gain" && g.out.includes(panelBus)),
    );
  ok("at least one relay tick fires within 3s of a starved reserve", ticks.length >= 1, `${ticks.length}`);

  // Un-starved: the tick simply stops firing — `reactorTickAt` is a
  // minimum-gap timestamp now, not a due-time accumulator, so it is *not*
  // reset here (see the flicker regression below for why that distinction
  // matters).
  s.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: true, docked: false, energy: 1, starved: false });
  const quietFrom = mark();
  for (let i = 0; i < 6; i++) {
    ctx.currentTime += 0.5;
    s.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: true, docked: false, energy: 1, starved: false });
  }
  const noTicks = nodes
    .slice(quietFrom)
    .filter((n) => n.kind === "biquad" && n.type === "highpass" && n.frequency.events[0] && n.frequency.events[0][1] === 3200);
  ok("the relay tick stops once the reserve is no longer starved", noTicks.length === 0, `${noTicks.length}`);

  // The flicker regression (review finding): `Ship.updateEnergy` skips the
  // drain outright while starved but always applies regen, so a ship pinned
  // at the impulse floor genuinely oscillates in and out of `starved` a few
  // times a second — regen ticks it just above the floor, the next frame's
  // settling ticks it back under. A reset-on-exit accumulator would fire on
  // every one of those re-entries; the minimum-gap timer must not. Stress it
  // harder than the real ~0.35-0.4s cycle: alternate every 0.1s for 3s.
  const ctx2 = makeContext();
  globalThis.AudioContext = function () { return ctx2; };
  nodes = [];
  const flicker = new Sound();
  flicker.start();
  flicker.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: true, docked: false, energy: 0.02, starved: true });
  const panelBus2 = flicker.synth.context.buses.panel;
  const flickerFrom = mark();
  for (let i = 0; i < 30; i++) {
    ctx2.currentTime += 0.1;
    flicker.update({
      threat: 0,
      hull: 1,
      thrust: 0,
      speed: 0,
      alive: true,
      docked: false,
      energy: 0.02,
      starved: i % 2 === 0,
    });
  }
  const flickerTicks = nodes
    .slice(flickerFrom)
    .filter(
      (n) =>
        n.kind === "biquad" &&
        n.type === "highpass" &&
        n.frequency.events[0] &&
        n.frequency.events[0][1] === 3200 &&
        n.out.some((g) => g.kind === "gain" && g.out.includes(panelBus2)),
    );
  // ≈ 3s / 1.4s, rounded up — not the ~15 a reset-on-exit accumulator would
  // produce by ticking on nearly every other 0.1s step.
  ok(
    "a flickering starved state does not speed the relay tick past its own cadence",
    flickerTicks.length <= 3,
    `${flickerTicks.length}`,
  );

  // silence() — a new run, or the title screen — resets the timer, so it is
  // the one place a stale gap from a *previous* run's reserve is allowed to
  // be thrown away.
  const ctx3 = makeContext();
  globalThis.AudioContext = function () { return ctx3; };
  nodes = [];
  const s3 = new Sound();
  s3.start();
  s3.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: true, docked: false, energy: 0.02, starved: true });
  s3.silence();
  const panelBus3 = s3.synth.context.buses.panel;
  const afterSilence = mark();
  // Barely any audio time passes — well under the 1.4s cadence — so this
  // only ticks if `silence()` actually reset the timestamp.
  ctx3.currentTime += 0.05;
  s3.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: true, docked: false, energy: 0.02, starved: true });
  const ticksAfterSilence = nodes
    .slice(afterSilence)
    .filter(
      (n) =>
        n.kind === "biquad" &&
        n.type === "highpass" &&
        n.frequency.events[0] &&
        n.frequency.events[0][1] === 3200 &&
        n.out.some((g) => g.kind === "gain" && g.out.includes(panelBus3)),
    );
  ok(
    "silence() resets the relay timer, so the next run's first starved frame ticks immediately",
    ticksAfterSilence.length === 1,
    `${ticksAfterSilence.length}`,
  );
}

// ── 13. the scanner as a second ear, and the Shroud's swell ────────────────
{
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();
  s.listen(0, 0, 0);

  // A wide, unresolved return: two tone voices, clearly detuned.
  let from = mark();
  s.ping(0.3, 60, 20);
  let tones = voicesSince(from).filter((v) => v.kind === "tone");
  ok("a wide-spread ping schedules two tone voices on the panel bus", tones.length === 2, `${tones.length}`);
  ok("...both sine", tones.every((v) => v.wave === "sine"), tones.map((v) => v.wave).join(","));
  let [lo, hi] = tones.map((v) => v.from).sort((a, b) => a - b);
  let beat = (hi - lo) / ((hi + lo) / 2);
  ok("...detuned from each other by at least 2% — rough, per spread/errorFar × 0.03", beat >= 0.02, `${beat}`);
  ok(
    "lastPing records the spread it was given, for the probe",
    s.lastPing !== null && s.lastPing.spread === 20,
    JSON.stringify(s.lastPing),
  );

  // A near-resolved return, well under the ghost floor of 2: the same two
  // voices, close enough together to read as one note.
  ctx.currentTime += 1; // clears the 90ms gate and reaps the last ping's voices
  from = mark();
  s.ping(0.3, 60, 1);
  tones = voicesSince(from).filter((v) => v.kind === "tone");
  [lo, hi] = tones.map((v) => v.from).sort((a, b) => a - b);
  beat = (hi - lo) / ((hi + lo) / 2);
  ok("a tight-spread ping detunes under a third of a percent — a clean unison", beat < 0.003, `${beat}`);

  // A resolved contact (spread 0) is that same unison at its cleanest.
  ctx.currentTime += 1;
  from = mark();
  s.ping(0.3, 60, 0);
  tones = voicesSince(from).filter((v) => v.kind === "tone");
  ok(
    "a resolved contact's two voices land on exactly the same frequency",
    tones.length === 2 && tones[0].from === tones[1].from,
    `${tones.map((v) => v.from)}`,
  );

  // Rate limit: several contacts can cross the arm in the same frame, and a
  // chorus of pips is not information — a second ping inside 90ms is
  // dropped outright, not thinned.
  ctx.currentTime += 1;
  const dropFrom = mark();
  s.ping(0.3, 60, 5);
  ok("a ping schedules voices", voicesSince(dropFrom).length > 0, "");
  const secondFrom = mark();
  s.ping(0.7, 40, 5);
  ok(
    "a second ping inside 90ms is dropped entirely",
    voicesSince(secondFrom).length === 0,
    `${voicesSince(secondFrom).length}`,
  );
  ctx.currentTime += 0.1; // past PING.rate
  const thirdFrom = mark();
  s.ping(0.7, 40, 5);
  ok(
    "...and is allowed again once 90ms has passed",
    voicesSince(thirdFrom).length === 2,
    `${voicesSince(thirdFrom).length}`,
  );

  // The duck: pinging reaches into the weapon bus and no other, same
  // structural bus-gain identification §3's duck test uses.
  ctx.currentTime += 1;
  const master = nodes.find((n) => n.kind === "gain" && n.out.some((o) => o.kind === "biquad" && o.type === "highpass"));
  const busGains = nodes.filter((n) => n.kind === "gain" && n.out.includes(master));
  const beforeEvents = busGains.map((g) => g.gain.events.length);
  s.ping(0, 30, 3);
  const duckedBuses = busGains.filter((g, i) => g.gain.events.length > beforeEvents[i]);
  ok("ping ducks exactly one bus (weapon)", duckedBuses.length === 1, `${duckedBuses.length} buses touched`);

  // Pan follows the scanner's own bearing convention (`ScannerModel.update`):
  // 0 is dead right (`cos(0) = 1`), π is dead left.
  ctx.currentTime += 1;
  const rightFrom = mark();
  s.ping(0, 30, 0);
  const rightPan = nodes.slice(rightFrom).find((n) => n.kind === "panner");
  ok(
    "bearing 0 (the scanner's own right axis) pans hard right",
    rightPan && rightPan.pan.value > 0.5,
    rightPan ? `${rightPan.pan.value}` : "no panner",
  );
  ctx.currentTime += 1;
  const leftFrom = mark();
  s.ping(Math.PI, 30, 0);
  const leftPan = nodes.slice(leftFrom).find((n) => n.kind === "panner");
  ok(
    "bearing π (dead left) pans hard left",
    leftPan && leftPan.pan.value < -0.5,
    leftPan ? `${leftPan.pan.value}` : "no panner",
  );

  // ── the Shroud's swell ───────────────────────────────────────────────────
  // Re-voiced from a detuned pair to an fm swell: a modulator driving the
  // carrier's frequency (§8's own fm plumbing), the carrier itself climbing
  // (the swell), and a plain resolving tone landing in the Shroud's own
  // bolt register just before the real bolt.
  const dFrom = mark();
  s.decloak(10, 10);
  const dFresh = nodes.slice(dFrom);
  const oscs = dFresh.filter((n) => n.kind === "oscillator");
  ok("decloak builds three oscillators: an fm pair plus a resolving tone", oscs.length === 3, `${oscs.length}`);

  // The fm pair, found the way §8 finds one: the one gain node fed by an
  // oscillator (the modulator) whose own output reaches another
  // oscillator's frequency param (the carrier) — unique regardless of how
  // many plain tone oscillators share the same node list.
  const depthGain = dFresh.find(
    (g) => g.kind === "gain" && oscs.some((o) => o.out.includes(g)) && oscs.some((c) => g.out.includes(c.frequency)),
  );
  const modulator = oscs.find((o) => depthGain && o.out.includes(depthGain));
  const carrier = oscs.find((o) => depthGain && depthGain.out.includes(o.frequency));
  const resolveTone = oscs.find((o) => o !== modulator && o !== carrier);
  ok("an fm pair exists: a modulator driving the carrier's frequency", !!depthGain && !!modulator && !!carrier, "no fm pair found");
  near(
    "the modulator sits at the golden ratio × the carrier — inharmonic, deliberately not shieldHit's 2.01",
    modulator && carrier ? modulator.frequency.events[0][1] / carrier.frequency.events[0][1] : 0,
    1.618,
    1e-6,
  );
  ok(
    "the carrier climbs — `to` lands above its own starting frequency (the swell)",
    carrier && carrier.frequency.events.some((e) => e[0] === "exp" && e[1] > carrier.frequency.events[0][1]),
    "",
  );
  ok(
    "the modulator's own depth carries a scheduled envelope (the index settling)",
    depthGain && depthGain.gain.events.length >= 2,
    "",
  );
  const depthRamp = depthGain && depthGain.gain.events.find((e) => e[0] === "exp");
  const carrierAt = carrier ? carrier.frequency.events[0][2] : 0;
  near(
    "...settling across the whole wind-up (`indexDecay: CLOAK_WIND`, 0.45s) rather than a struck note's usual quick decay",
    depthRamp ? depthRamp[2] - carrierAt : -1,
    0.45,
    0.01,
  );

  ok("a resolving tone follows, in the Shroud's own bolt register", !!resolveTone, "no resolve tone found");
  near(
    "...starting at 520 Hz — hostileFire's own opening note",
    resolveTone ? resolveTone.frequency.events[0][1] : 0,
    520,
    1e-6,
  );
  near(
    "...landing `CLOAK_WIND - 0.03` after the swell opens — three hundredths of a second before the real bolt",
    resolveTone ? resolveTone.frequency.events[0][2] - carrierAt : -1,
    0.45 - 0.03,
    0.01,
  );
}

// ── 14. hostile identities, and the mines' tick ─────────────────────────────
{
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();
  s.listen(0, 0, 0);

  // Swarmer: bright and thin, the top of the hostile band.
  let from = mark();
  s.hostileFire(3, 3, "swarmer");
  let tones = voicesSince(from).filter((v) => v.kind === "tone");
  ok(
    "a swarmer's shot schedules a tone above 700 Hz — the top of the hostile band",
    tones.some((v) => v.from > 700),
    tones.map((v) => v.from).join(","),
  );

  // Sniper: one voice, a narrow fm bite, well under the swarmer's register.
  ctx.currentTime += 1;
  from = mark();
  s.hostileFire(3, 3, "sniper");
  const sniperVoices = voicesSince(from);
  ok("a sniper's shot schedules exactly one voice", sniperVoices.length === 1, `${sniperVoices.length}`);
  near("...starting at 700 Hz", sniperVoices[0]?.from ?? 0, 700, 1e-6);

  // Brawler: the one class allowed two voices for one budget slot, and the
  // tone dips under 200 Hz — the heavy, low register the noise layer alone
  // does not reach.
  ctx.currentTime += 1;
  from = mark();
  s.hostileFire(3, 3, "brawler");
  const brawlerVoices = voicesSince(from);
  ok("a brawler's shot schedules two voices", brawlerVoices.length === 2, `${brawlerVoices.length}`);
  ok(
    "...one of them below 200 Hz",
    brawlerVoices.some((v) => v.from < 200),
    brawlerVoices.map((v) => v.from).join(","),
  );

  // Guard: every class's own fire, pitched six percent low — `GUARD_PITCH`,
  // the same offset the guard's radio signature will use.
  ctx.currentTime += 1;
  from = mark();
  s.hostileFire(3, 3, "swarmer", false);
  const plainFrom = voicesSince(from)[0]?.from ?? 0;
  ctx.currentTime += 1;
  from = mark();
  s.hostileFire(3, 3, "swarmer", true);
  const guardFrom = voicesSince(from)[0]?.from ?? 0;
  near("a guard's shot lands six percent low of the plain class", guardFrom / plainFrom, 0.94, 0.01);

  // The Lance's own tell: rising, the opposite shape of the bolt it precedes.
  ctx.currentTime += 1;
  from = mark();
  s.lanceCharge(3, 3);
  const chargeVoices = voicesSince(from);
  ok(
    "lanceCharge schedules a rising tone",
    chargeVoices.length === 1 && chargeVoices[0].to > chargeVoices[0].from,
    chargeVoices.map((v) => `${v.from}->${v.to}`).join(","),
  );
  ok(
    "lastLanceCharge records the audio-clock time it sounded, for the probe",
    s.lastLanceCharge !== null && s.lastLanceCharge.at === ctx.currentTime,
    JSON.stringify(s.lastLanceCharge),
  );

  // A mine arming: a short, bandpassed click.
  ctx.currentTime += 1;
  from = mark();
  s.mineArm(3, 3);
  const armVoices = voicesSince(from).filter((v) => v.kind === "noise");
  ok(
    "mineArm schedules a bandpassed noise click",
    armVoices.length === 1 && armVoices[0].filter === "bandpass",
    armVoices.map((v) => v.filter).join(","),
  );

  // The mine tick's own rate limit: `near: 1` sets a 0.15s interval
  // (`0.9 − 0.75 × 1`), so two calls under 100ms apart schedule once.
  ctx.currentTime += 1;
  from = mark();
  s.mineTick(0, 0, 1);
  ok("a mine tick at near=1 schedules a voice", voicesSince(from).length === 1, `${voicesSince(from).length}`);
  ctx.currentTime += 0.05; // well under the 0.15s interval
  const secondFrom = mark();
  s.mineTick(0, 0, 1);
  ok(
    "a second tick inside 100ms is dropped — the cue's own rate limiter, not the caller's",
    voicesSince(secondFrom).length === 0,
    `${voicesSince(secondFrom).length}`,
  );
  ctx.currentTime += 0.2; // past the 0.15s interval, measured from the first tick
  const thirdFrom = mark();
  s.mineTick(0, 0, 1);
  ok(
    "...and ticks again once the interval has passed",
    voicesSince(thirdFrom).length === 1,
    `${voicesSince(thirdFrom).length}`,
  );
}

// ── 15. damage by facing, breach's cost, and the death near-silence ────────
{
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();
  s.listen(0, 0, 0);

  // Pan says which facing took it, not where the bolt started — see
  // `shieldHit`'s own docblock.
  let from = mark();
  s.shieldHit(1, 1, "port", 1);
  const portPan = nodes.slice(from).find((n) => n.kind === "panner");
  ok("a port hit pans left", portPan && portPan.pan.value < 0, portPan ? `${portPan.pan.value}` : "no panner");

  // `remaining` scales the fm ring's own index — read the modulator depth
  // gain's initial value the way §8 and §13 both do: the one gain fed by an
  // oscillator whose own output reaches another oscillator's frequency param.
  const depthAt = (fresh) => {
    const oscs = fresh.filter((n) => n.kind === "oscillator");
    const depthGain = fresh.find(
      (g) =>
        g.kind === "gain" &&
        oscs.some((o) => o.out.includes(g)) &&
        oscs.some((c) => g.out.includes(c.frequency)),
    );
    return depthGain ? depthGain.gain.events[0][1] : -1;
  };
  ctx.currentTime += 1;
  from = mark();
  s.shieldHit(1, 1, "port", 1);
  const fullDepth = depthAt(nodes.slice(from));
  ctx.currentTime += 1;
  from = mark();
  s.shieldHit(1, 1, "port", 0.05);
  const thinDepth = depthAt(nodes.slice(from));
  ok(
    "a nearly spent facing rings with a lower index than a fresh one",
    fullDepth > 0 && thinDepth > 0 && thinDepth < fullDepth,
    `${thinDepth} vs ${fullDepth}`,
  );

  // breach: two tones a 70 Hz beat apart — the roughest sound in the bank.
  ctx.currentTime += 1;
  from = mark();
  s.breach();
  const breachTones = voicesSince(from).filter((v) => v.kind === "tone");
  ok("breach schedules two tones", breachTones.length === 2, `${breachTones.length}`);
  const [lo, hi] = breachTones.map((v) => v.from).sort((a, b) => a - b);
  near("...a 70 Hz beat apart (90 and 160 Hz)", hi - lo, 70, 3);

  // multiplierHalved: the falling figure, on the panel bus, split from breach.
  ctx.currentTime += 1;
  from = mark();
  s.multiplierHalved();
  const lossVoices = voicesSince(from);
  ok("multiplierHalved schedules a two-note falling figure", lossVoices.length === 2, `${lossVoices.length}`);
  ok(
    "...falling, not rising",
    lossVoices[0].from > lossVoices[1].from,
    `${lossVoices.map((v) => v.from).join(" then ")}`,
  );

  // death: exactly four voices, one group, none reaching into the drift.
  ctx.currentTime += 1;
  from = mark();
  s.death();
  const deathVoices = voicesSince(from);
  ok("death schedules exactly four voices", deathVoices.length === 4, `${deathVoices.length}`);
  ok(
    "none of them delay past 1.2s — the drift stays silent by design",
    deathVoices.every((v) => v.at - ctx.currentTime <= 1.2),
    deathVoices.map((v) => (v.at - ctx.currentTime).toFixed(2)).join(","),
  );
}

// ── 15b. deathPower survives Sound.update()'s own alive:false gate ─────────
// The regression this section exists to catch: `main.ts` calls `Sound.update`
// every frame regardless of `Session.state`, with `alive: false` for the
// entire death sequence — and its own gate used to zero the engine/reactor
// beds' level outright on that flag alone, well inside `Bed`'s own glide,
// which made `deathPower`'s own dimming inaudible no matter what `power()`
// wrote a moment earlier. Interleaved here in the exact order production
// code uses: `deathPower(p)` then `update({alive:false, ...})`, every frame.
{
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();

  // Build the reactor bed live first, the way a real run does before death.
  s.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: true, docked: false, energy: 1, starved: false });
  const lowpassFilters = nodes.filter((n) => n.kind === "biquad" && n.type === "lowpass");
  const reactorFilter = lowpassFilters.find(
    (f) => nodes.filter((n) => n.kind === "oscillator" && n.out.includes(f)).length === 2,
  );
  const reactorTremolo = nodes.find((n) => n.kind === "gain" && reactorFilter.out.includes(n));
  const reactorGain = nodes.find((n) => n.kind === "gain" && reactorTremolo.out.includes(n));
  const lastTarget = () => reactorGain.gain.events[reactorGain.gain.events.length - 1][1];

  const targets = [];
  for (const p of [1.0, 0.85, 0.7, 0.55, 0.4, 0.3]) {
    ctx.currentTime += 0.2;
    s.deathPower(p);
    s.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: false, docked: false, energy: 1, starved: false });
    targets.push(lastTarget());
  }
  ok(
    "while deathPower is active, update()'s alive:false gate does not zero the reactor",
    targets.every((v) => v > 0),
    JSON.stringify(targets),
  );
  ok(
    "...and the target follows the falling power, not a fixed level",
    targets.every((v, i) => i === 0 || v <= targets[i - 1] + 1e-9),
    JSON.stringify(targets),
  );

  // panelRestore hands the alive gate back: the very next alive:false
  // update() zeroes the reactor exactly as it did before deathPower existed.
  ctx.currentTime += 0.2;
  s.panelRestore();
  s.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: false, docked: false, energy: 1, starved: false });
  ok("panelRestore hands the alive gate back — a dead, non-dying scene zeroes the reactor again", lastTarget() === 0, `${lastTarget()}`);

  // silence() clears the same hold, independent of panelRestore.
  ctx.currentTime += 0.2;
  s.deathPower(0.5);
  s.silence();
  ctx.currentTime += 0.2;
  s.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: false, docked: false, energy: 1, starved: false });
  ok("silence() also clears the deathPower hold", lastTarget() === 0, `${lastTarget()}`);
}

// ── deathPower drives every bed's own filter and gain ──────────────────────
{
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();
  s.update({ threat: 400, hull: 0.6, thrust: 0.5, speed: 30, alive: true, docked: false, energy: 0.7, starved: false });

  // Structural, the same way §11/§12 pick the two live beds apart: the
  // engine is noise-kind (fed by a buffer source), the reactor is tone-kind
  // (fed by two oscillators) — both build a lowpass filter.
  const lowpassFilters = nodes.filter((n) => n.kind === "biquad" && n.type === "lowpass");
  const engineFilter = lowpassFilters.find((f) => nodes.some((n) => n.kind === "buffersource" && n.out.includes(f)));
  const reactorFilter = lowpassFilters.find((f) => f !== engineFilter);
  // `Bed.build`'s own chain: filter → tremolo (a gain) → the bed's own gain → bus.
  const bedGain = (filter) => {
    const tremolo = nodes.find((n) => n.kind === "gain" && filter.out.includes(n));
    return tremolo && nodes.find((n) => n.kind === "gain" && tremolo.out.includes(n));
  };
  const engineGain = bedGain(engineFilter);
  const reactorGain = bedGain(reactorFilter);
  ok(
    "both live beds are found, filter and gain",
    !!engineFilter && !!reactorFilter && !!engineGain && !!reactorGain,
    "",
  );

  const before = [engineFilter, reactorFilter, engineGain, reactorGain].map(
    (n) => n.kind === "gain" ? n.gain.events.length : n.frequency.events.length,
  );

  s.deathPower(0.2);

  const after = [engineFilter, reactorFilter, engineGain, reactorGain].map(
    (n) => n.kind === "gain" ? n.gain.events.length : n.frequency.events.length,
  );
  ok("deathPower writes to the engine's filter", after[0] > before[0], `${before[0]} -> ${after[0]}`);
  ok("deathPower writes to the reactor's filter", after[1] > before[1], `${before[1]} -> ${after[1]}`);
  ok("deathPower writes to the engine's gain", after[2] > before[2], `${before[2]} -> ${after[2]}`);
  ok("deathPower writes to the reactor's gain", after[3] > before[3], `${before[3]} -> ${after[3]}`);

  // The silent, never-built alert bed rides along in the same call without
  // throwing — `power`'s own guarded-no-op contract, same as `set` and `dip`.
  let threw = null;
  try {
    s.deathPower(0);
  } catch (error) {
    threw = error;
  }
  ok("deathPower with a never-built bed in the mix does not throw", threw === null, String(threw));

  // silence() resets a bed's own power scale — a fresh run must not inherit
  // the previous run's death dimming. The engine's idle level at rest is a
  // fixed constant (0.028, `Sound.update`'s own formula) — still scaled by
  // 0.2 if `powerScale` survived `silence()`, exactly 0.028 if it was reset.
  s.silence();
  s.update({ threat: 0, hull: 1, thrust: 0, speed: 0, alive: true, docked: false, energy: 1, starved: false });
  const lastGainEvent = engineGain.gain.events[engineGain.gain.events.length - 1];
  near(
    "after silence(), a bed's gain target is no longer scaled down by the last run's death",
    lastGainEvent[1],
    0.028,
    0.002,
  );
}

// ── 16. the multiplier family: one motif in four registers ─────────────────
// `deposit` (inside `kill`), `multiplierTick`, `salvageTransfer` and `tally`
// all read pitches off the same `MOTIF` — this section is the "four
// registers agree" check the brief names: every frequency any of the four
// schedules has to be some `motifHz(220, d) × 2^k` for a plain octave shift
// k, or the shared vocabulary is a claim rather than a fact.
{
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();
  s.listen(0, 0, 0);

  // A test-local mirror of `sound.ts`'s own MOTIF/motifHz — the same
  // reasoning every other structural check in this file gives: the point is
  // to verify the bank's own arithmetic against an independent copy, not to
  // import the thing under test and check it equals itself.
  const MOTIF = [0, 4, 7, 12];
  const motifHz = (root, degree) => root * Math.pow(2, MOTIF[degree] / 12);
  const onMotif = (freq) => {
    for (let d = 0; d < MOTIF.length; d++) {
      for (const k of [-1, 0, 1, 2]) {
        if (Math.abs(freq / (motifHz(220, d) * Math.pow(2, k)) - 1) < 0.01) return true;
      }
    }
    return false;
  };

  // kill's own deposit: one extra voice beyond the three-layer blast, a
  // triangle (the family's own timbre) rather than the blast's own sine/noise.
  let from = mark();
  s.kill(4, 4, 1, 2.6);
  const killVoices = voicesSince(from);
  const depositVoices = killVoices.filter((v) => v.wave === "triangle");
  ok("a paid kill schedules exactly one deposit note beyond its own blast", killVoices.length === 4 && depositVoices.length === 1, `${killVoices.length} voices, ${depositVoices.length} triangle`);
  ok("...and it lands on a motif degree", onMotif(depositVoices[0].from), `${depositVoices[0].from}`);

  // The Warden's own kill (no multiplier passed) pays no deposit.
  ctx.currentTime += 1;
  from = mark();
  s.kill(4, 4, 1);
  ok("a kill with no multiplier (the Warden's own) schedules no deposit", voicesSince(from).length === 3, `${voicesSince(from).length}`);

  // multiplierTick: the same family, quieter — defined and tested even
  // though no live call site wires it yet (see its own docblock).
  ctx.currentTime += 1;
  from = mark();
  s.multiplierTick(2.6);
  const tick = voicesSince(from);
  ok("multiplierTick schedules one note", tick.length === 1, `${tick.length}`);
  ok("...on a motif degree", onMotif(tick[0].from), `${tick[0].from}`);
  ok("...quieter than the deposit", tick[0].level < depositVoices[0].level, `${tick[0].level} vs ${depositVoices[0].level}`);
  near("...the same degree as a deposit at the same multiplier", tick[0].from, depositVoices[0].from, 0.5);

  // salvageTransfer: ascending across the steps, every note on the motif.
  ctx.currentTime += 1;
  from = mark();
  s.salvageTransfer(0, 3);
  ctx.currentTime += 1;
  s.salvageTransfer(1, 3);
  ctx.currentTime += 1;
  s.salvageTransfer(2, 3);
  const steps = voicesSince(from);
  ok(
    "salvageTransfer schedules three notes, all on the motif",
    steps.length === 3 && steps.every((v) => onMotif(v.from)),
    steps.map((v) => v.from.toFixed(1)).join(","),
  );
  ok("...ascending", steps[0].from < steps[1].from && steps[1].from < steps[2].from, steps.map((v) => v.from.toFixed(1)).join(","));

  // tally, re-rooted: `tally(4.5, 900)` schedules several notes, all on the motif.
  ctx.currentTime += 1;
  from = mark();
  s.tally(4.5, 900);
  const tallyVoices = voicesSince(from);
  ok("tally(4.5, 900) schedules at least three notes", tallyVoices.length >= 3, `${tallyVoices.length}`);
  ok(
    "...every one on a motif degree",
    tallyVoices.every((v) => onMotif(v.from)),
    tallyVoices.map((v) => v.from.toFixed(1)).join(","),
  );

  // approach: off course alternates short/long; on course holds one long tone.
  ctx.currentTime += 1;
  from = mark();
  s.approach(0.8, false);
  const offCourse = voicesSince(from);
  ok("approach(0.8, false) schedules two tones", offCourse.length === 2, `${offCourse.length}`);
  ok("...of different lengths", offCourse.length === 2 && offCourse[0].hold !== offCourse[1].hold, offCourse.map((v) => v.hold).join(","));
  ok("...at 700 Hz", offCourse.every((v) => Math.abs(v.from - 700) < 1), offCourse.map((v) => v.from).join(","));

  ctx.currentTime += 1;
  from = mark();
  s.approach(0, true);
  const onCourseVoices = voicesSince(from);
  ok(
    "approach(0, true) schedules one long-hold tone",
    onCourseVoices.length === 1 && onCourseVoices[0].hold > 0.3,
    JSON.stringify(onCourseVoices.map((v) => v.hold)),
  );

  // The other side of the beam reverses which tone is short and which is long.
  ctx.currentTime += 1;
  from = mark();
  s.approach(-0.8, false);
  const otherSide = voicesSince(from);
  ok(
    "the other side of the beam reverses the pattern",
    otherSide.length === 2 && otherSide[0].hold !== offCourse[0].hold,
    `${otherSide[0] && otherSide[0].hold} vs ${offCourse[0].hold}`,
  );

  // Rate limit: a call in the same instant as the one above schedules nothing.
  from = mark();
  s.approach(0.8, false);
  ok("approach rate-limits to one call per 0.35s", voicesSince(from).length === 0, `${voicesSince(from).length}`);

  // The four registers agree: every frequency collected above is a motif
  // degree times a plain octave — the whole point of this task.
  const allFreqs = [depositVoices[0].from, tick[0].from, ...steps.map((v) => v.from), ...tallyVoices.map((v) => v.from)];
  ok(
    "the four registers agree: every frequency is a motif degree × 2^k",
    allFreqs.every(onMotif),
    allFreqs.map((f) => f.toFixed(1)).join(","),
  );
}

// ── 17. the radio: three parties, one channel ───────────────────────────────
// Task 11. `Radio` (`radio.ts`) is the scheduling half — which party gets the
// channel right now — over `composePhrase`'s pure grammar (Task 3, §9
// above) and `Synth.speak`/`duck` (also Task 3, §9/§3). This section is
// where §9's own placeholder — "a phrase counts as one radio voice" —
// finally becomes a real assertion, against `Radio` itself rather than a
// bare loop of `synth.speak` calls.
{
  const { Radio, CADENCES } = await import(join(out, "audio/radio.js"));
  const { composePhrase } = await import(join(out, "audio/formant.js"));

  // Cadence shape, independent of scheduling: raider reads as several short,
  // clipped syllables; hammer as few, long, unhurried ones — the two ends of
  // "clipped and fast" vs "slow and monotone" this module's own header
  // describes chatter carrying instead of words. `CADENCES.raider` is
  // `syllablesMin: 2, syllablesMax: 4` — the binding numbers, not widened
  // for this test's convenience — so the seed below is chosen deliberately
  // (its first draw lands `composePhrase`'s own syllable-count roll on the
  // top of that range) rather than the cadence being loosened to make an
  // arbitrary seed pass.
  let seed = 85183;
  const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const raiderPhrase = composePhrase(CADENCES.raider, rng);
  ok(
    "raider's own cadence: several syllables, every one clipped short",
    raiderPhrase.syllables.length >= 3 && raiderPhrase.syllables.every((s) => s.length < 0.08),
    `${raiderPhrase.syllables.length} syllables, lengths ${raiderPhrase.syllables.map((s) => s.length.toFixed(3)).join(",")}`,
  );
  const hammerPhrase = composePhrase(CADENCES.hammer, rng);
  ok(
    "hammer's own cadence: every syllable long and slow",
    hammerPhrase.syllables.length > 0 && hammerPhrase.syllables.every((s) => s.length >= 0.14),
    hammerPhrase.syllables.map((s) => s.length.toFixed(3)).join(","),
  );

  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const synth = new Synth();
  synth.start();
  const radio = new Radio(synth);

  // `commit`: the Shroud's own reveal — no phrase, two squelches only.
  // `now` is always `ctx.currentTime` itself throughout this section, kept
  // in lockstep by advancing the mock's own clock rather than a
  // separately-tracked variable — `Radio`'s busy/queue bookkeeping runs on
  // whatever `now` it is handed, and letting that drift from the audio
  // clock `Synth.speak` itself reads is exactly the kind of bug this note
  // exists to keep out: an earlier draft of this test tracked its own
  // `busyNow` beside `ctx.currentTime` and let the two fall out of sync,
  // which read a still-busy channel as free and silently dropped a call the
  // assertion below needed to have actually spoken.
  let from = mark();
  radio.say("theirs", "commit", { doctrine: "raider", now: ctx.currentTime, rng: Math.random });
  const commitFresh = nodes.slice(from);
  ok(
    "commit is squelch-only: exactly two noise bursts",
    commitFresh.filter((n) => n.kind === "buffersource").length === 2,
    `${commitFresh.filter((n) => n.kind === "buffersource").length}`,
  );
  // The syllable gate specifically, not just any gain node in the call — the
  // two squelch bursts have their own gains, and *those* ramp on every call,
  // commit included. Found the way §9 already finds it for its own
  // zero-syllable check: the one gain every formant bandpass connects into.
  const commitBandpasses = commitFresh.filter((n) => n.kind === "biquad" && n.type === "bandpass");
  const commitGate = commitFresh.find(
    (n) => n.kind === "gain" && commitBandpasses.length > 0 && commitBandpasses.every((bp) => bp.out.includes(n)),
  );
  ok(
    "...and opens no syllable gate",
    !commitGate || !commitGate.gain.events.some((e) => e[0] === "lin"),
    "the syllable gate ramped despite zero syllables to voice",
  );
  ok(
    "...and still records as a phrase having spoken",
    radio.lastPhrase?.party === "theirs" && radio.lastPhrase?.event === "commit",
    JSON.stringify(radio.lastPhrase),
  );

  // Priority: a low-priority event arriving while the party is already
  // speaking is dropped outright — `lastPhrase` does not move.
  ctx.currentTime += 5; // clear of `commit`'s own tiny span
  radio.say("theirs", "charge", { doctrine: "raider", now: ctx.currentTime, rng: Math.random });
  const afterFirstCharge = radio.lastPhrase;
  ctx.currentTime += 0.01; // still well inside the charge phrase's own span
  radio.say("theirs", "charge", { doctrine: "raider", now: ctx.currentTime, rng: Math.random });
  ok(
    "a low-priority event while the party is already speaking is dropped",
    radio.lastPhrase === afterFirstCharge,
    JSON.stringify(radio.lastPhrase),
  );

  // Parties are independent: `theirs` being busy never holds up `ours`.
  radio.say("ours", "dispatch", { now: ctx.currentTime, rng: Math.random });
  ok(
    "a different party is never dropped for another party's busy line",
    radio.lastPhrase.party === "ours" && radio.lastPhrase.event === "dispatch",
    JSON.stringify(radio.lastPhrase),
  );

  // Every `say` ducks the weapon bus — reading the bus gains structurally,
  // §3's own duck test's technique: exactly one bus gain picks up fresh
  // scheduled events (`Synth.speak` itself never writes to a bus gain's own
  // `.gain` param, only `duck` does), so "one bus touched" is "the duck fired".
  ctx.currentTime += 5; // clear of every phrase scheduled so far
  const master = nodes.find((n) => n.kind === "gain" && n.out.some((o) => o.kind === "biquad" && o.type === "highpass"));
  const busGains = nodes.filter((n) => n.kind === "gain" && n.out.includes(master));
  const beforeEvents = busGains.map((g) => g.gain.events.length);
  radio.say("theirs", "wave", { doctrine: "hammer", now: ctx.currentTime, rng: Math.random });
  const ducked = busGains.filter((g, i) => g.gain.events.length > beforeEvents[i]);
  ok("every say ducks exactly one bus (the weapon bus)", ducked.length === 1, `${ducked.length} buses touched`);

  // Guard: the commander's guard reads six percent low over the air, the
  // same offset `sound.hostileFire`'s own guard boost applies to its shot.
  // Same rng sequence both times (a fresh, identically-seeded generator per
  // call) isolates the one thing that should differ: `pitchBase` scaled by
  // `GUARD_PITCH_SCALE`, which the "level" contour only ever *adds* jitter
  // on top of — so the two carriers' starting pitches should differ by
  // exactly `pitchBase * (1 - 0.94)`, not by some unrelated jitter draw.
  ctx.currentTime += 5; // clear of the duck test's own phrase
  let gseed = 5;
  const grng = () => (gseed = (gseed * 48271) % 2147483647) / 2147483647;
  const plainFrom = mark();
  gseed = 5;
  radio.say("theirs", "wave", { doctrine: "hammer", now: ctx.currentTime, rng: grng });
  const plainCarrier = nodes.slice(plainFrom).find((n) => n.kind === "oscillator");
  const plainPitch = plainCarrier.frequency.events[0][1];
  ctx.currentTime += 5; // clear of the plain phrase's own span before the guarded one
  const guardFrom = mark();
  gseed = 5;
  radio.say("theirs", "wave", { doctrine: "hammer", guard: true, now: ctx.currentTime, rng: grng });
  const guardCarrier = nodes.slice(guardFrom).find((n) => n.kind === "oscillator");
  const guardPitch = guardCarrier.frequency.events[0][1];
  near(
    "the commander's guard speaks six percent low",
    plainPitch - guardPitch,
    CADENCES.hammer.pitchBase * (1 - 0.94),
    0.5,
  );

  // The cap itself: the radio bus admits exactly 3 cues and refuses the
  // surplus, ungrouped — §9's own placeholder, made real. Calls `speak`
  // directly rather than through `Radio`, on a fresh bus so nothing above
  // this line contaminates the count: `Radio`'s own per-party bookkeeping
  // is what keeps ordinary play from ever asking for a 4th voice on one
  // bus at once (one live phrase per party, three parties, cap 3), but
  // that guarantee is a *policy* this class enforces on top of `Synth`,
  // not a limit `Synth` itself is aware of — this section tests the limit
  // underneath the policy.
  const capCtx = makeContext();
  globalThis.AudioContext = function () { return capCtx; };
  nodes = [];
  const capSynth = new Synth();
  capSynth.start();
  const tiny = { syllables: [{ at: 0, length: 0.05, pitch: 160, f1: 500, f2: 1500, f3: 2500, level: 1 }], duration: 0.05 };
  const capFrom = mark();
  for (let i = 0; i < 5; i++) {
    capSynth.speak({ phrase: tiny, bus: "radio", level: 0.4, drive: 2, band: [300, 3400] });
  }
  const capVoices = voicesSince(capFrom);
  ok(
    "the radio bus admits exactly 3 phrases and refuses the rest",
    capVoices.filter((v) => v.kind === "tone").length === 3,
    `${capVoices.filter((v) => v.kind === "tone").length} tones scheduled`,
  );

  // `Sound.say`'s own never-throw contract. Unlike every other cue, this
  // one runs pure logic (`Radio.say`'s bookkeeping, `composePhrase`)
  // *before* it ever reaches one of `Synth`'s own guarded methods — and
  // `dispatch`/`allyHail`/`allyComms`/`allyLost` all call it first now,
  // ahead of the sound they already make, so a throw in here must retire
  // the layer the way `Synth`'s own internal failures do, not escape into
  // the frame loop. `Math.random` is what `Sound.say` hands `Radio.say` as
  // its `rng` — monkey-patching it to throw is the least invasive way to
  // make `composePhrase` fail on the real call path, rather than calling
  // `Radio.say` directly and merely proving *this test's own* try/catch works.
  const failCtx = makeContext();
  globalThis.AudioContext = function () { return failCtx; };
  nodes = [];
  const failSound = new Sound();
  failSound.start();
  failSound.listen(0, 0, 0);
  const realRandom = Math.random;
  Math.random = () => {
    throw new Error("rng exploded");
  };
  const warningsBefore = warnings.length;
  let threw = null;
  try {
    failSound.say("theirs", "wave", { doctrine: "raider" });
  } catch (error) {
    threw = error;
  }
  Math.random = realRandom;
  ok("a throwing rng inside Radio.say does not escape Sound.say", threw === null, String(threw));
  ok(
    "...and the layer retires the way any other internal Synth failure does",
    warnings.length === warningsBefore + 1 && warnings[warningsBefore].startsWith("audio disabled"),
    warnings.slice(warningsBefore).join("; "),
  );
  const afterFailFrom = mark();
  failSound.dispatch();
  ok("...so a cue after the failure no longer schedules anything", voicesSince(afterFailFrom).length === 0, "");
}

// ── 18. sectors have a body: a room per sector, ducked under threat ────────

const { roomFor } = await import(join(out, "audio/acoustics.js"));

{
  // `roomFor` itself: pure, no WebAudio, the spec's own table turned into
  // numbers.
  const rocks = roomFor("rocks", false, false);
  ok(
    "rocks: four discrete early reflections — a torpedo comes back off the field",
    rocks.earlyReflections.length === 4,
    `${rocks.earlyReflections.length}`,
  );

  const bare = roomFor("bare", false, false);
  ok("bare: bone dry", bare.wet === 0, `${bare.wet}`);

  const giant = roomFor("giant", false, false);
  ok("giant: a long dark tail, ~2s", giant.tailSeconds >= 1.8, `${giant.tailSeconds}`);

  const shoaledGiant = roomFor("giant", true, false);
  ok("shoal: cutoff drops under 1500 Hz even on an already-dark room", shoaledGiant.tailCutoffHz < 1500, `${shoaledGiant.tailCutoffHz}`);
  const shoaledRocks = roomFor("rocks", true, false);
  ok("shoal: cutoff drops under 1500 Hz on a bright room too", shoaledRocks.tailCutoffHz < 1500, `${shoaledRocks.tailCutoffHz}`);
  ok(
    "shoal: a ceiling, never a brightener — the giant's own 600 Hz is untouched by a 1200 Hz cap",
    shoaledGiant.tailCutoffHz === giant.tailCutoffHz,
    `${shoaledGiant.tailCutoffHz} vs ${giant.tailCutoffHz}`,
  );
  ok("shoal: the tail lengthens", shoaledRocks.tailSeconds > rocks.tailSeconds, `${shoaledRocks.tailSeconds} vs ${rocks.tailSeconds}`);
  ok("shoal: the mix wets further", shoaledRocks.wet > rocks.wet, `${shoaledRocks.wet} vs ${rocks.wet}`);

  const mist = roomFor("rocks", true, true);
  ok("inside the comet: noise, not a room — overrides hero and shoal alike", mist.noiseOnly === true, "");
  ok("...the loudest send in the bank", mist.wet > rocks.wet && mist.wet > shoaledRocks.wet, `${mist.wet}`);
}

{
  // `Sound.enterSector`: builds the convolver, and the probe agrees with
  // what `roomFor` itself would say.
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();
  s.listen(0, 0, 0);
  ok("no room on the probe before a sector is entered", s.room === null, "");

  s.enterSector("rocks", false, 11, 4);
  const conv = nodes.find((n) => n.kind === "convolver");
  ok("enterSector builds a convolver with a buffer", conv && conv.buffer !== null, "");
  ok(
    "the probe reports the room's name and wet",
    s.room && s.room.name === "rocks" && s.room.wet === roomFor("rocks", false, false).wet,
    JSON.stringify(s.room),
  );

  s.enterSector("rocks", false, 11, 4); // same key: a no-op
  ok(
    "re-entering the same sector does not rebuild the convolver",
    nodes.filter((n) => n.kind === "convolver").length === 1,
    "",
  );

  s.enterSector("rocks", true, 11, 4); // shoal flag differs: a real change
  ok(
    "a shoal appearing over the same sector is a different key",
    s.room && s.room.name === "rocks+shoal",
    JSON.stringify(s.room),
  );

  s.enterSector("bare", false, 11, 5);
  ok("a bare sector reads wet 0 on the probe too", s.room && s.room.wet === 0, JSON.stringify(s.room));
}

{
  // Determinism: the same (seed, sector) renders the same IR bytes, on two
  // entirely separate `Sound` instances — a reload must not re-roll the
  // room the way a reload never re-rolls `planHero` itself.
  const ctxA = makeContext();
  globalThis.AudioContext = function () { return ctxA; };
  nodes = [];
  const a = new Sound();
  a.start();
  a.enterSector("rocks", false, 42, 9);
  const bufA = Array.from(nodes.find((n) => n.kind === "convolver").buffer.getChannelData(0));

  const ctxB = makeContext();
  globalThis.AudioContext = function () { return ctxB; };
  nodes = [];
  const b = new Sound();
  b.start();
  b.enterSector("rocks", false, 42, 9);
  const bufB = Array.from(nodes.find((n) => n.kind === "convolver").buffer.getChannelData(0));
  ok(
    "the same (seed, sector) renders the same room, byte for byte",
    bufA.length === bufB.length && bufA.every((v, i) => v === bufB[i]),
    "",
  );

  nodes = [];
  const c = new Sound();
  c.start();
  c.enterSector("rocks", false, 42, 10); // a different sector, same seed
  const bufC = Array.from(nodes.find((n) => n.kind === "convolver").buffer.getChannelData(0));
  ok("a different sector renders a different room", !bufA.every((v, i) => v === bufC[i]), "");
}

{
  // `insideComet`: overrides the sector's room while latched, and restores
  // whichever sector is actually current — not necessarily the one that was
  // showing when the tail closed over the ship — once it lets go.
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();
  s.listen(0, 0, 0);
  s.enterSector("giant", false, 5, 2);
  const sectorWet = s.room.wet;

  s.insideComet(0.2); // below the 0.5 strip threshold: no change
  ok("below the strip threshold, the sector's room stays", s.room.name === "giant", JSON.stringify(s.room));

  s.insideComet(0.9); // above it: the tail takes over
  ok("above the strip threshold, the room becomes the comet's own mist", s.room.name === "comet", JSON.stringify(s.room));
  ok("...at a wetter level than the sector it replaced", s.room.wet > sectorWet, `${s.room.wet} vs ${sectorWet}`);

  // A sector change while inside the tail is recorded but not applied — the
  // suppression is total, so a rocks field's slap-echo has no business
  // fading back in until the tail actually lets go.
  s.enterSector("bare", false, 5, 3);
  ok("a sector change while inside the comet does not touch the room yet", s.room.name === "comet", JSON.stringify(s.room));

  s.insideComet(0.1); // dropping back out
  ok(
    "dropping back out restores the sector actually current, not the one before the tail closed",
    s.room && s.room.name === "bare" && s.room.wet === 0,
    JSON.stringify(s.room),
  );
}

{
  // The threat duck: `update` scales every open send down as threat rises,
  // and `silence` lets go of the duck immediately rather than waiting for
  // threat to fall back to zero.
  const ctx = makeContext();
  globalThis.AudioContext = function () { return ctx; };
  nodes = [];
  const s = new Sound();
  s.start();
  s.listen(0, 0, 0);
  s.enterSector("rocks", false, 3, 1); // wet 0.3, so the sends are actually open
  const conv = nodes.find((n) => n.kind === "convolver");
  const sends = nodes.filter((n) => n.kind === "gain" && n.out.includes(conv));
  const eventsBefore = sends.map((g) => g.gain.events.length);
  const before = s.synth.sendLevels();
  ok("sends are open before any threat", before.weapon > 0, `${before.weapon}`);

  const scene = (threat) => ({ threat, hull: 1, thrust: 0, speed: 0, alive: true, docked: false, energy: 1, starved: false });
  s.update(scene(1100)); // FULL_THREAT — full-volume alarm
  ok(
    "full threat schedules a fresh gain event on every open send",
    sends.every((g, i) => g.gain.events.length > eventsBefore[i]),
    "",
  );
  const ducked = s.synth.sendLevels();
  near("full threat ducks the space to 0.3× (1 − 0.7×1)", ducked.weapon / before.weapon, 0.3, 1e-9);
  ok("bed and radio stay pinned dry regardless", ducked.bed === 0 && ducked.radio === 0, "");

  s.update(scene(0)); // threat clears
  const restored = s.synth.sendLevels();
  near("threat clearing restores the sends", restored.weapon, before.weapon, 1e-9);

  s.update(scene(1100)); // duck it again
  s.silence();
  const afterSilence = s.synth.sendLevels();
  near(
    "silence() releases the duck immediately, without waiting for threat to clear",
    afterSilence.weapon,
    before.weapon,
    1e-9,
  );
}

// ── report ─────────────────────────────────────────────────────────────────

console.warn = realWarn;
rmSync(out, { recursive: true, force: true });

for (const failure of failures) console.error(`  FAIL  ${failure}`);
console.log(`\naudio: ${passed} assertions passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
