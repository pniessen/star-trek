import { Group, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from "three";
import { makeRng } from "../chart/rng.js";
import { GIANT } from "./GasGiant.js";
import type { SectorLight } from "./light.js";

/**
 * The hero moon — scenery task 2, the second `HeroKind` `main.ts`'s
 * `sectorHero` can pick after task 1's giant/ringed pair. Modelled on
 * `render/GasGiant.ts`'s class shape on purpose (`GasGiant.ts:885-1123`):
 * the `key` cache + `clear()` idiom so `show()` is a no-op unless the sector
 * actually changed, the anchor/leash `follow` so the body holds station
 * rather than letting the player fly through it, `fog: false` on the
 * material for the same reason the giant needs it (this body sits at
 * `GIANT.range`, well past `Stage`'s fog far plane, and a hand-written
 * `ShaderMaterial` gets no automatic fog unless it opts in), and the
 * `renderOrder` convention `Planet.ts`'s ring shares — behind the
 * camera-pinned sky's own nearer bodies, in front of nothing this game
 * ever draws two hero bodies over at once, since `main.ts`'s hero block is
 * an exclusive `if`/`else` chain and only one of giant/ringed/moon/sun/rocks
 * ever shows in a given sector.
 *
 * What does not carry over, per the brief: no atmosphere halo (no `limb`
 * mesh at all — airless is the character, so the silhouette stays exactly
 * as sharp as the sphere's own tessellation, never softened by an additive
 * fresnel shell), no domain-warped flow field (a crater field is pits, not
 * weather — cellular/Worley noise instead of `fbm3`), and no lifted
 * lighting floor (the giant's `ambientFloor` exists to keep a *banded*
 * night side legible against a competing pattern; a moon has no pattern to
 * protect, and the brief calls for a genuinely hard terminator — plain
 * `max(dot(n, l), 0.0)`, no wrap term added back in).
 */
export const MOON = {
  // ── placement and scale ───────────────────────────────────────────────
  // Same distances as the giant's own — "same leash/anchor scheme at the
  // giant's distances" per the brief — rather than a second, redundant set
  // of range/minRange/height constants that could drift out of step with
  // them. `GIANT.range`/`GIANT.minRange`/`GIANT.height` are read directly
  // in `show`/`follow` below instead of copied here.

  /** Fraction of `GIANT.radius` the body's own radius is rolled from —
   * "0.55 + rng.next() * 0.15" per the brief, i.e. the 0.55-0.7 band. Kept
   * as separate min/max constants rather than one derived range so the band
   * reads directly off the file the way `GIANT.baseHueMin`/`baseHueMax` do. */
  radiusMin: 0.55,
  radiusMax: 0.7,

  /** Radians per second the crater field turns — first-draft, unflown, same
   * species as every other constant on `docs/todo.md`'s tuning list. Well
   * under `GIANT.rotationRate` (0.035): an airless rock's *surface* moving
   * is a much subtler cue than a gas giant's weather visibly flowing, and a
   * fast tumble here would read as a toy spinning rather than a moon
   * turning — this is slow enough that the terminator's own sweep is what
   * carries the motion, not the crater pattern racing past it. */
  rotationRate: 0.006,

  /** Latitude/longitude divisions. Well below the giant's 48×32 on purpose
   * — nothing here is banded or needs a smooth fresnel term for a limb
   * shell that does not exist, so tessellation only has to keep the
   * silhouette round, which this body's smaller screen radius (55-70% of
   * the giant's) needs less of to begin with. */
  widthSegments: 32,
  heightSegments: 24,

  // ── surface ────────────────────────────────────────────────────────────

  /** Frequency the lat/lon pair is scaled to before it reaches the Worley
   * cell lookup — the brief's own `uCraterScale`, 9.0, unrolled per sector:
   * a fixed density of pits pole to pole rather than a per-sector roll,
   * since a randomised crater count was never asked for and "moon" is
   * already the variety task's coarse-grained roll (giant vs. ringed vs.
   * moon vs. sun vs. rocks vs. bare). */
  craterScale: 9.0,
} as const;

/**
 * `body`'s vertex stage — the same shape as `GasGiant.ts`'s `BODY_VERTEX`,
 * trimmed to what a craters-and-terminator-only fragment stage actually
 * reads: `vObjectNormal` for the lat/lon lookup (before any transform, so
 * the crater field is a function of the mesh alone and rides `uRotation`
 * for free the same way the giant's flow field does), `vViewNormal` and
 * `vLightDirView` for the lighting term. No `vViewDir` — there is no limb
 * shell here to fresnel-shade, so nothing downstream ever reads it.
 */
const BODY_VERTEX = `
uniform vec3 uLightDirWorld;
varying vec3 vObjectNormal;
varying vec3 vViewNormal;
varying vec3 vLightDirView;
void main() {
  vObjectNormal = normal;
  vViewNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vLightDirView = normalize((viewMatrix * vec4(uLightDirWorld, 0.0)).xyz);
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * `body`'s fragment stage. The brief's own crater recipe (task-2-brief.md
 * step 1), wired into this file's uniform/varying conventions rather than
 * the giant's: `uv` is the same lat/lon pair the giant's `flowPoint` reads
 * off `vObjectNormal`, `uRotation` folds into longitude the same way, and
 * the lighting term at the bottom is the giant's own `wn`/`ld`/`ndotl`
 * shape with its `uAmbientFloor` lift removed — the brief calls for a hard
 * terminator, so the night side is allowed to go to true black the way
 * `render/light.ts`'s own `STAR.floor` comment warns a *bodyless* dark
 * side would ("a hole where geometry should be"); that trade is accepted
 * here on purpose, because an airless rock with no scattered light and no
 * competing surface pattern to protect is exactly the case that comment
 * says the floor is not for.
 */
const BODY_FRAGMENT = `
uniform float uRotation;
uniform float uCraterScale;
uniform vec3 uLightColor;

varying vec3 vObjectNormal;
varying vec3 vViewNormal;
varying vec3 vLightDirView;

// Hash and cellular (Worley) noise — craters are pits, not weather.
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float worley(vec2 p) {
  vec2 cell = floor(p); vec2 f = fract(p);
  float d = 1.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = hash2(cell + g);
    d = min(d, length(g + o - f));
  }
  return d;
}

void main() {
  // Lat/lon from the sphere normal, the same read GasGiant.ts's own
  // fragment shader opens with — see that file's comment on the +1e-6 atan
  // tie-break at the poles.
  vec3 n = normalize(vObjectNormal);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(n.x, n.z + 1e-6) + uRotation;
  vec2 uv = vec2(lon, lat);

  float crater = smoothstep(0.18, 0.05, worley(uv * uCraterScale));        // pit
  float rim    = smoothstep(0.22, 0.18, worley(uv * uCraterScale)) - crater; // bright lip
  float macro  = worley(uv * uCraterScale * 0.23);                          // maria
  vec3 albedo = mix(vec3(0.38, 0.36, 0.33), vec3(0.55, 0.52, 0.47), macro);
  albedo *= 1.0 - 0.55 * crater;   // pits darken
  albedo += 0.18 * rim;            // rims catch light

  vec3 wn = normalize(vViewNormal);
  vec3 ld = normalize(vLightDirView);
  float lit = max(dot(wn, ld), 0.0);   // hard terminator: no wrap term

  gl_FragColor = vec4(albedo * uLightColor * lit, 1.0);
}
`;

/**
 * One hero moon. `main.ts` holds a single instance beside `giant`/`planet`
 * and only calls `show`/`follow`/`update` while `sectorHero === "moon"`,
 * `hide()` otherwise — see that file's hero block.
 */
export class Moon {
  readonly object = Object.assign(new Group(), { name: "moon" });

  /** The lit surface — the whole body, since there is no separate limb
   * shell. Public for the same reason `GasGiant.body` is: a harness can
   * read the geometry/material directly without this class inventing an
   * indirection just to be testable. */
  body: Mesh | null = null;

  private key = "";
  /** Where the body sits before the leash. */
  private readonly anchor = new Vector3();

  /**
   * Rebuild for a sector, if it is not already the one standing. `light` is
   * the sector's own `SectorLight`, the same object `main.ts` hands the
   * giant — one place still rolls a sector's star.
   */
  show(seed: number, sector: number, light: SectorLight): void {
    const key = `${seed}:${sector}`;
    if (key === this.key) return;
    this.key = key;
    this.clear();

    // A hash mix distinct from every other one this game rolls a sector
    // feature with — scenery's own (1103515245/12820163/53231), light's
    // (1274126177/741103597/1013904223), Planet's (2654435761/40503/977),
    // GasGiant's (3628273133/2308142839/97354729) and comet's
    // (2246822519/3266489917/668265263). Reusing any of them would
    // correlate this body's radius/spin with another sector feature's own
    // roll, the same furniture problem those files' own comments warn
    // against.
    const rng = makeRng((seed * 2971215073 + sector * 1640531527 + 3559788179) >>> 0);

    const radiusFrac = MOON.radiusMin + rng.next() * (MOON.radiusMax - MOON.radiusMin);
    const radius = GIANT.radius * radiusFrac;
    const rotation0 = rng.next() * Math.PI * 2;

    const geometry = new SphereGeometry(radius, MOON.widthSegments, MOON.heightSegments);

    // Same direction the giant's own `show` reuses — `sun.target` in
    // `main.ts` is always the origin, so a real `DirectionalLight`'s
    // illumination direction is `position` alone, normalised.
    const lightDir = light.position.clone().normalize();

    this.body = new Mesh(
      geometry,
      new ShaderMaterial({
        uniforms: {
          uRotation: { value: rotation0 },
          uCraterScale: { value: MOON.craterScale },
          uLightDirWorld: { value: lightDir },
          uLightColor: { value: light.colour.clone() },
        },
        vertexShader: BODY_VERTEX,
        fragmentShader: BODY_FRAGMENT,
        // See this file's own header and `GasGiant.ts`'s own `fog: false`
        // comment: this body lives at `GIANT.range`, past `Stage`'s fog far
        // plane, and a hand-written shader gets no automatic fog unless it
        // opts in.
        fog: false,
      }),
    );
    // Same value `Planet.ts`'s own ring body gets — behind the camera-pinned
    // sky's nearer bodies, ahead of nothing. Never coincides with the
    // giant's own -1.98 or the ringed planet's own -1.97 draw in the same
    // frame: `main.ts`'s hero block is one `if`/`else` chain, so at most one
    // hero body exists at a time.
    this.body.renderOrder = -1.97;
    this.object.add(this.body);

    // Same fixed bearing the giant holds — dead ahead of spawn — and the
    // same reason: whichever hero `planHero` cast for this sector should be
    // the one thing on screen the moment a run starts, not something that
    // might roll in behind the player.
    this.anchor.set(0, GIANT.height, GIANT.range);
    this.object.position.copy(this.anchor);
  }

  /** Hold station if the player has come too close — the giant's own leash
   * logic, unchanged, at the giant's own `minRange`. */
  follow(player: Vector3): void {
    if (!this.body) return;
    const dx = this.anchor.x - player.x;
    const dz = this.anchor.z - player.z;
    const flat = Math.hypot(dx, dz);
    if (flat >= GIANT.minRange || flat < 1e-3) {
      this.object.position.copy(this.anchor);
    } else {
      const push = GIANT.minRange / flat;
      this.object.position.set(player.x + dx * push, GIANT.height, player.z + dz * push);
    }
  }

  /** Advances the sample coordinate rather than rotating the mesh — the
   * giant's own item 7 choice, reused for the same reason: nothing
   * downstream of the vertex stage has to recompute anything a static mesh
   * was not already giving it for free. */
  update(dt: number): void {
    if (!this.body) return;
    const material = this.body.material as ShaderMaterial;
    material.uniforms.uRotation.value += MOON.rotationRate * dt;
  }

  /** Empty the group and forget the sector, so the next `show` rebuilds. */
  hide(): void {
    if (this.key === "") return;
    this.key = "";
    this.clear();
  }

  /** Torn down on a sector change, the same moment `GasGiant.clear` is. */
  clear(): void {
    if (this.body) {
      this.body.geometry.dispose();
      (this.body.material as ShaderMaterial).dispose();
    }
    this.body = null;
    for (const child of [...this.object.children]) this.object.remove(child);
  }
}
