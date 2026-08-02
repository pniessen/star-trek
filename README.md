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

## The short version

Build **Kobayashi** (pure vector arcade, Sega-1982 split screen) as milestone one, then
grow it into **Deep Black** (a modern *Star Raiders*: cockpit combat welded to a live
strategic chart). They share a renderer and a combat model, so the first is the honest
first slice of the second.

Stack: TypeScript + Vite + Three.js, WebGL2, WebAudio synthesis. No engine.

Naming: our own universe. The genre isn't protectable; the marks are.
