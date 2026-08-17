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

/** Every cue in the bank, called the way the game calls it. */
function everyCue(s) {
  s.listen(0, 0, 0);
  s.update({ threat: 400, hull: 0.6, thrust: 0.5, speed: 30, alive: true, docked: false });
  s.phaser(true, 1);
  s.phaser(false, 0);
  s.torpedo(false);
  s.torpedo(true);
  s.hostileFire(3, 3);
  s.nearMiss(3, 3);
  s.impact(2, 2);
  s.thud(2, 2);
  s.kill(4, 4, 1.4);
  s.shieldHit(1, 1);
  s.breach();
  s.mineBlast(5, 5);
  s.mineLay(6, 6);
  s.decloak(7, 7);
  s.withdraw(6, 6);
  s.dispatch();
  s.wave(3);
  s.hyperwarpCharge(2);
  s.hyperwarpAbort();
  s.hyperwarpArrive();
  s.scram();
  s.alertBeat(110, 4);
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
  s.update({ threat: 9, hull: 1, thrust: 1, speed: 9, alive: true, docked: false });
  ok("mid-run failure: stays retired", voicesSince(after).length === 0);
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

// ── report ─────────────────────────────────────────────────────────────────

console.warn = realWarn;
rmSync(out, { recursive: true, force: true });

for (const failure of failures) console.error(`  FAIL  ${failure}`);
console.log(`\naudio: ${passed} assertions passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
