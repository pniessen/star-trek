# Deep Black — working title

A starship game with first-person vector combat and a galaxy that moves while you're busy.
Currently at the research-and-concepts stage; no code yet.

## Docs

- [docs/prior-art.md](docs/prior-art.md) — what's already been made, from the 1971 BASIC
  *Star Trek* through Star Raiders, the vector arcades, the Interplay/Totally Games era,
  and the modern indie school. Includes what's worth taking from each, and where the gap
  is.
- [docs/concept-options.md](docs/concept-options.md) — four concepts (Deep Black,
  Kobayashi, Watch Officer, Long Survey), a recommendation, and the technical direction
  for the vector look.
- [docs/pitch.html](docs/pitch.html) — the same material as a visual dossier, with a live
  wireframe demo of the target aesthetic. Open it in a browser.

## Running it

```
npm install
npm run dev          # http://127.0.0.1:5173
npm run typecheck
node tools/shots.mjs shots   # headless screenshots of every mode
```

Arrows or WASD to turn and thrust. Toggles: `G` geometry (wireframe ↔ occluded),
`B` bloom, `F` phosphor, `V` CRT glass, `H` HUD, `1`/`2`/`3` cockpit/chase/orbit,
`[` `]` trail length, `-` `=` bloom strength.

## Status

Milestone one — the renderer — is in. Wireframe/occluded toggle, bloom, phosphor
persistence, CRT glass, a stroke-drawn HUD with no DOM text in it, planar flight
on a single energy pool, and four shield facings displayed. No combat yet.

Locked design decisions: play space is a plane (so the tactical scanner never
lies), one energy pool for thrust/shields/weapons, four separately-depleting
shield facings, phasers that weaken with distance versus limited-ammo torpedoes.
See [docs/concept-options.md](docs/concept-options.md).

## The short version

Build **Kobayashi** (pure vector arcade, Sega-1982 split screen) as milestone one, then
grow it into **Deep Black** (a modern *Star Raiders*: cockpit combat welded to a live
strategic chart). They share a renderer and a combat model, so the first is the honest
first slice of the second.

Stack: TypeScript + Vite + Three.js, WebGL2, WebAudio synthesis. No engine.

Naming: our own universe. The genre isn't protectable; the marks are.
