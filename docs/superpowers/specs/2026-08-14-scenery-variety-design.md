# Scenery Variety — design

*Written 2026-08-14, approved in conversation before implementation. This is
the remainder of [environment.md](../../environment.md) — stages 3, 4 and 7 —
plus the one decision that plan deferred: the casting call. The gas giant was
built as a prototype and then shipped as a constant; every sector now shows
the same actor in different makeup. This document makes the hero a draw.*

Owner rulings, taken in conversation: **full scope** (hero variety, mid-field
furniture, and gas shoals), and **asteroids are collidable hazards**, not
scenery-only and not (yet) shootable salvage.

---

## 1. The hero draw

One pure allocator, `planHero(seed, sector)` in a new `src/render/scenery.ts`,
with its own hash mix (distinct from `planPlanet`'s, `planFixture`'s,
`planLight`'s and the giant's — the same square must not pair the same
features). It returns one of six kinds, weighted:

| kind | weight | what it is |
|---|---|---|
| `giant` | 0.30 | the existing gas giant, unchanged |
| `ringed` | 0.20 | `Planet.ts` promoted to hero scale |
| `moon` | 0.15 | a new cratered rock world |
| `sun` | 0.15 | the sector's own star, close enough to dominate |
| `rocks` | 0.10 | an asteroid field as the hero |
| `bare` | 0.10 | no hero — deep space, the nebula sky carries the frame |

Consequences, each deliberate:

- **`GasGiant.show` becomes conditional on the draw** (a `hide()` for the
  five other kinds). The giant goes back to being an event.
- **`Planet.ts`'s independent 38% roll is retired.** The ringed planet
  becomes the `ringed` hero: same body, hero scale (its existing
  `scale` band raised so it reads as the frame's owner, not furniture).
  `planPlanet` keeps its internals but is called by the allocator, not by
  its own coin.
- **`bare` is a place, not an absence.** No new work beyond the draw —
  the per-sector nebula sky already exists — but the deck log may say so
  (§6), because emptiness that is named reads as chosen.
- The comet, Loom, minefield and starbase are unaffected; they layer over
  any hero as they do today.

Determinism: same `(seed, sector)` → same hero, forever, by construction.

## 2. Two new bodies

Both follow the giant's own settled pattern — a lit filled mesh (environment.md
§1.5's correction: strokes govern hulls, not celestial bodies), shaded by the
sector's `SectorLight`, leashed and followed like the giant, fog-exempt.

- **The moon.** The giant's `ShaderMaterial` approach with a rocky recipe:
  desaturated grey-tan palette band, crater field from the same noise family
  (cellular/worley-flavoured rather than flow-warped — craters are pits, not
  weather), a hard terminator, no atmosphere halo (airless is the character;
  the limb stays crisp where the giant's blooms). Smaller than the giant
  (~0.6× radius band) but still frame-dominating at its leash.
- **The sun hero.** Not a surface — it *is* light (environment.md §5's own
  words). A bright disc at the sector light's own bearing, close enough to
  dominate, with a bloom-driven halo (brightness distribution, not geometry)
  and a faint streamer corona. It must agree with `light.ts`: the hero sun
  sits along `SectorLight.position`'s direction so every lit body and the
  hero agree about where the light comes from. In a `sun` sector the
  black-body colour constraint already landed in `light.ts` does the palette
  work for free.

## 3. Asteroids — the field, the furniture, and the collision

### 3.1 Geometry

Rocks are merged low-poly lit meshes (environment.md §4.3: one geometry per
cluster, not forty objects), irregular (jittered icosahedra), desaturated
grey-brown — the "small and distant stays desaturated" mitigation is doing
real work here, because a warm small rock at range is a Raider to a glance.
Rocks never pulse, never flash. Slow tumble (`dt`-based) on the merged
cluster's parent.

- **The `rocks` hero**: a broad field centred off-sector-centre, a few dozen
  rocks across combat space, radius band ~3–9 units each, plus a dense
  distant band for depth.
- **Furniture** (every sector, hero-independent, seeded by its own mix):
  0–2 small clusters at mid-distance (the 260–600 band the fog work opened),
  occasionally a drifting dead hulk (one merged wreck silhouette in the
  occluded-hull idiom — it was a ship, so it may be strokes; scenery
  otherwise stays mesh). Furniture never enters combat range and never
  collides.

### 3.2 Collision — the rocks do not care

Player-only, hero-field-only (furniture is out of reach by construction):

- Sphere tests against the field's rock list (centre, radius) each frame.
  On contact: **push-out** along the contact normal (never clip inside),
  **velocity reflection** with a hefty damping (a wall, not a trampoline),
  and **damage through the existing lanes**: `player.takeHit(amount, rockCentre)`
  — the struck facing absorbs, the remainder breaches, a breach halves the
  multiplier exactly as any hull contact does. The game has already taught
  this price.
- `amount` scales with impact speed along the normal, with a **grace floor**
  (below a gentle-nudge speed the rock shoulders you off for free — parking
  against a rock must not be a death sentence) and a ceiling (one collision
  is never instantly lethal from full shields).
- A thud through the existing two voices (filtered-noise body + low pitched
  knock), placed at the contact. `HIT_STOP.impact` on a damaging strike —
  the existing bounded system, no new time scale.
- **Hostiles avoid rather than collide**: a cheap radial repulsion from
  nearby rocks folded into their existing steering (bounded like the strafe
  tangent), because pilots read as pilots and a hostile clipping through a
  rock the player must dodge reads as a cheat. No hostile takes rock damage
  — free kills from herding would need an economy ruling this spec does not
  make.
- The scanner stays clean: bodies never appear as contacts (the locked
  mitigation). The rocks are canopy-read — big, slow, lit. The altitude slab
  matters here: rocks occupy real `y`, and flying *over* a field is the
  skill the slab already sells.

Fiction, one line, taught once in the deck log (§6): the rocks do not care.

## 4. Gas shoals

Environment.md stage 4, built on the comet plume's proven technique:
filament curtains at combat range — dense connected strands, luminous under
bloom, seeded in ~1 in 5 sectors (independent of the hero; a shoal over a
bare sector is a gift).

- **Scenery gets its `TraceBuffer` back.** The `skyTrace` instance was
  deleted when the giant went to a mesh, with its `(capacity, fog)`
  parameters kept "for a later stage's own scratch pad" — this is that
  stage. `new TraceBuffer(20000, false)`, drawn between starfield and grid.
- **Visual occlusion only.** Shoals hide and reveal hulls to the *eye*.
  They do not jam, do not break locks, do not degrade the scanner — **the
  comet owns instrument interference**, and a second fog with the same
  power would dilute the one rule that makes the comet a place. Recorded
  here as a decision, not an omission.
- Drift slow enough to plan around for a run, like the comet fixture.

## 5. The harness, and the budget

The playtest harness runs under SwiftShader and already hides the giant to
keep the dt clamp out of slow motion. Every body this spec adds must be
hideable the same way, through **one switch**: a `scenery` handle exposed on
localhost (`window.__scenery.hide()` / `.show()`, covering hero bodies,
rock fields, furniture and shoals), and the harness calls it beside the
existing `__giant` hide (which folds into it). Segment and draw-call counts
recorded in `docs/todo.md` the way the comet's and kill rings' are; the
shoal's filament budget is the number to watch (the comet spends 779 of
combat's 5000; the shoal has its own 20000).

## 6. The deck log

One line per notable fact, in the house register, read off `planHero` (the
same board-derived contract as the comet's line):

- `rocks` hero: "AN ASTEROID FIELD CROWDS THIS SECTOR" — and on the teach
  run only, "THE ROCKS DO NOT CARE".
- `bare`: "NOTHING HERE BUT THE DEEP" (or per implementation, in-voice).
- Other heroes go unannounced — a planet is scenery, not a briefing item;
  the log speaks only when a fact changes how you fly.

## 7. Testing

- **Playtest:** hero determinism (same seed+sector twice → same kind, two
  different sectors can differ — the giant-seeding checks' own pattern);
  every kind reachable (sweep `planHero` over enough sectors in-page and
  assert all six occur); collision (teleport the player onto a hero rock at
  speed via the probe → a facing drops, and at breach speed the multiplier
  halves; below the grace floor → no damage); the `__scenery` hide switch
  exists and empties the draw (the harness itself uses it, which is the
  standing proof); shoal presence in a seeded sector.
- **Audiotest:** the collision thud's contract row.
- **`npm run typecheck`**; chart modules untouched (this is all render/game).

## 8. Out of scope, explicitly

- Shootable/mineable asteroids (an economy verb — its own spec if ever).
- Shoal sensor effects (the comet's, by decision above).
- Hostile-vs-rock damage; rock-vs-torpedo collision (torpedoes fly true —
  changing that resizes the weapon, not the scenery).
- Per-sector docking, and any change to where the starbase sits.
- New keybindings, new HUD rows, new currencies. The control surface stays
  full.

## 9. Documents to amend on landing

- `environment.md`: staging table marked — stages 3/4/7 delivered here,
  stage 8 (retiring the Backdrop's painted bodies) remains and is *not*
  taken by this spec.
- `CLAUDE.md` State section; `docs/todo.md` §2 gains the new first-draft
  constants (weights, rock damage curve/grace/ceiling, shoal density,
  repulsion gain) in the standing style.
