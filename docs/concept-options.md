# Four concepts

All four hit the brief's three pillars — first-person battle, navigation/adventure/
strategy, vector aesthetic — at different mixes and different costs. See
[prior-art.md](./prior-art.md) for what each descends from.

---

## Option A — *Deep Black* (recommended)

**A modern Star Raiders.** Real-time first-person cockpit combat welded to a live
strategic galaxy map, structured as 30–60 minute roguelike runs.

**Loop.** Open the chart → an 8×8 sector grid, enemy fleets visibly moving between
sectors in real time, your three starbases under siege. Pick a target, spend energy on
hyperwarp, drop into the cockpit. Fight in first person: shields have facings, weapons
draw from the same energy pool as your engines, subsystems take localised damage. Warp
out or die. Dock to repair — which costs time you don't have, because the fleet advanced
while you were docked. Run ends when the last starbase falls or the invasion is broken.

**Why this one.** It's the exact design in the brief, the shape is proven, and no modern
version exists. The strategy layer gives every dogfight stakes; the dogfight gives the
map layer teeth. It's also the most *legible* pitch: "Star Raiders, 2026, in your
browser."

**Risk.** Two systems to build, and they have to talk to each other. Mitigated by
building the combat half first — that half is Option B, and it's shippable alone.

**Scope.** ~10–14 weeks to a strong vertical slice.

---

## Option B — *Kobayashi* (the fast one)

**Pure vector arcade.** One screen, no meta-layer: forward cockpit view on the bottom
two-thirds, overhead tactical scanner on the top third — the Sega 1982 split — with
escalating waves, a docking mini-game to refuel, and a leaderboard. Five-minute sessions.

**Why.** It's the aesthetic showcase. Everything about the vector look — beam bloom,
phosphor decay, the overhead scanner sweep, the wireframe explosion that pops apart into
its constituent line segments — lands here with no strategy code to write. Ships in
weeks, not months, and it's the honest first milestone of Option A regardless.

**Risk.** Thin. Arcade high-score games live or die on feel, so if the feel isn't there
there's nothing else holding it up.

**Scope.** ~4–5 weeks to something genuinely fun.

---

## Option C — *Watch Officer* (the systems sim)

**You command; you don't pilot.** Bridge Commander × FTL × EmptyEpsilon. The screen is
your bridge: viewscreen forward (first-person, vector), stations around it. You issue
orders — helm to a heading, tactical to target their weapons array, engineering to shunt
power from sensors to shields — and watch them execute with realistic lag. Combat is
about power budget and shield facing, not aim.

**Why.** The deepest strategy of the four and the strongest fantasy of actually *being
the captain*. Diegetic instrument panels are a natural fit for the vector look — every
readout is already a line drawing. Extends to co-op later (each player takes a station).

**Risk.** Least immediate. "First person" becomes "looking at a viewscreen", which is
further from the brief's battle element. Interface-heavy games take longer to make
readable than they look.

**Scope.** ~12–16 weeks; co-op is a separate project after that.

---

## Option D — *Long Survey* (the Trek-in-spirit one)

**Exploration-forward.** The 1971 quadrant grid as an *exploration* space rather than a
kill-list: anomalies, derelicts, first contacts, distress calls. Away missions and hails
resolve as short vector-illustrated encounter scenes with real choices. Combat exists but
is punctuation, not the loop — and the end-of-mission score rewards restraint, curiosity,
and diplomacy over kills, the way *25th Anniversary* did.

**Why.** The most distinctive, and the most actually-Trek of the four — nobody is making
this. Content-authored encounters are cheap to write and easy to expand indefinitely.

**Risk.** Furthest from "first person battle elements". Needs real writing to work, and
that's a different production problem than code.

**Scope.** ~8 weeks for the frame, then content forever.

---

## Recommendation

**Build B as milestone one, then grow it into A.** They share a renderer, a flight model,
a combat model, and an art direction; B is A's cockpit with the chart layer removed. That
sequencing gets something playable and good-looking in about a month, proves the feel
before we commit to the strategy layer, and de-risks the only genuinely hard part of A
(making two layers pressure each other).

Option D's encounter system is worth keeping in the back pocket — it drops into A's
strategy layer later as "what you find when you warp into an empty sector", which is
exactly the content A will be short of.

---

## Technical direction

**Stack:** TypeScript + Vite + Three.js, no game engine. WebGL2.

**The vector look** is a rendering recipe, not a modelling one:

| Element | Approach |
|---|---|
| Geometry | Wireframe only — `LineSegments2` / fat lines so strokes have real width and don't vanish at distance |
| Glow | `UnrealBloomPass` at a high threshold so only the traces bloom, with a second wide-radius low-strength pass for the halo |
| Phosphor decay | Feedback buffer — blend the previous frame back at ~0.85 so fast motion smears like a CRT |
| Beam artefacts | Slight brightness overshoot at line endpoints; corners hold the beam a moment longer than edges |
| Colour | Additive blending, so overlapping traces bloom to white where they cross |
| Curvature | Barrel-distortion + scanline pass, kept subtle and toggleable |
| Explosions | Break the model into its line segments and fling them — no particles, no sprites |
| Text/HUD | Stroke-drawn glyphs on the same canvas, never DOM text, so everything shares one visual world |

**Audio:** WebAudio synthesis rather than samples — square/saw bleeps, filtered noise for
warp, and a low pulsing drone that rises with alert level. Fits the aesthetic and keeps
the download tiny.

**Why web over Godot/Unity:** instant playability, shareable via link, no install, and
this specific look is cheap in WebGL (it's lines and post-processing, not models and
lightmaps). If we later want Steam, wrap it — the renderer doesn't change.

**Naming and IP:** the genre isn't protectable, the marks are. Build under our own name
and universe — see the legal note at the end of [prior-art.md](./prior-art.md).
