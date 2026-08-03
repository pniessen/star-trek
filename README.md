# Deep Black — working title

A starship game with first-person vector combat and a galaxy that moves while you're busy.
Currently a playable arcade run — combat, waves, docking and the greed multiplier —
with the strategy layer designed but not yet built.

## Docs

- [docs/status.md](docs/status.md) — **start here.** Full writeup: where the design
  came from, what is built, the decisions that are locked and why, the bugs found
  along the way, and the roadmap.
- [docs/prior-art.md](docs/prior-art.md) — what's already been made, from the 1971 BASIC
  *Star Trek* through Star Raiders, the vector arcades, the Interplay/Totally Games era,
  and the modern indie school. Includes what's worth taking from each, and where the gap
  is.
- [docs/concept-options.md](docs/concept-options.md) — four concepts (Deep Black,
  Kobayashi, Watch Officer, Long Survey), a recommendation, and the technical direction
  for the vector look.
- [docs/strategy-layer.md](docs/strategy-layer.md) — how empire building attaches to an
  arcade run: the chart, build costs, refit tradeoffs, how the enemy expands, and
  the rules that keep it from becoming homework.
- [docs/pitch.html](docs/pitch.html) — the research as a visual dossier, with a live
  wireframe demo of the target aesthetic. Open it in a browser.

## Running it

```
npm install
npm run dev          # http://127.0.0.1:5173
npm run typecheck
node tools/shots.mjs shots   # headless screenshots of every mode
```

Arrows or WASD to fly, `Space` phasers, `X` torpedoes, `R` to restart.
Toggles: `G` geometry (wireframe ↔ occluded), `B` bloom, `F` phosphor,
`V` CRT glass, `H` diagnostics, `1`/`2`/`3` cockpit/chase/orbit, `[` `]` trail
length, `-` `=` bloom strength.

`tools/playtest.mjs` drives a whole run headlessly and asserts the combat rules
fire — waves, kills, salvage, the multiplier, docking, death, restart.

> Note for headless runs: SwiftShader takes roughly half a second per frame for
> the post chain at 1280×800, and the loop's `dt` clamp then puts game logic
> into slow motion. The playtest therefore runs its assertions at 640×400 with
> post disabled and only turns everything back on for screenshots. On real
> hardware the same chain costs under 2ms.

## Status

**Milestone one — renderer.** Wireframe/occluded toggle, bloom, phosphor
persistence, CRT glass, output encode, stroke-drawn HUD with no DOM text in it.

**Milestone two — combat and docking.** Phasers (hitscan, energy-draining, weaker with
distance) and torpedoes (limited, must be led); three hostiles that each punish
one habit; shield facings that absorb by quarter; ships that explode into the
line segments that drew them; waves; docking as a skill test; and the greed
multiplier that ties it together.

**The overhead scanner is in** — heading-up, contacts glyphed by class, off-range
contacts pinned to the rim. It is the reason the play space is a plane.

Docking is a full sequence: approach corridor, tractor capture, staged
resupply, itemised tally, deliberate departure — and the waves keep coming
while you are moored.

Not yet: audio, mouse aim, leaderboards, the strategy layer.

Locked design decisions: play space is a plane (so the scanner never lies), one
energy pool for thrust/shields/weapons, four separately-depleting shield
facings, phasers that weaken with distance versus limited-ammo torpedoes, and no
win state within a run. See [docs/concept-options.md](docs/concept-options.md)
and [docs/strategy-layer.md](docs/strategy-layer.md).

## The short version

Build **Kobayashi** (pure vector arcade, Sega-1982 split screen) as milestone one, then
grow it into **Deep Black** (a modern *Star Raiders*: cockpit combat welded to a live
strategic chart). They share a renderer and a combat model, so the first is the honest
first slice of the second.

Stack: TypeScript + Vite + Three.js, WebGL2, WebAudio synthesis. No engine.

Naming: our own universe. The genre isn't protectable; the marks are.
