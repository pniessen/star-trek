import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  FrontSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from "three";
import { makeRng } from "../chart/rng.js";

/**
 * The hero gas giant — `docs/environment.md` §1.5, the rebuild that replaced
 * the stroke version. That version went three rounds (a transparent balloon,
 * a ball of thread, a ball of straw) and never reached a planet, because it
 * applied "occluded geometry, not pure wireframe" to a domain the decision was
 * never argued for: `CLAUDE.md`'s own justification for that rule is a claim
 * about *ships in combat*, and a planet does not overlap another planet.
 * §1.5's own table is why this file looks the way it does — a solid mesh
 * closes the far-side-bleed problem the camera cull existed for, and a real
 * `DirectionalLight` closes the moving-terminator problem the whole
 * stroke-shading split existed for. Neither workaround survives; both are
 * gone from this file rather than left dormant.
 *
 * **Two meshes, not the two-mechanism split the stroke version needed.**
 * `body` is a lit `SphereGeometry` whose vertex colours encode the banding —
 * computed once, in `show`, from the sector seed, because unlike the old
 * per-stroke shading, a real light does the moving part for free and the
 * surface pattern itself never has to change frame to frame. `limb` is a
 * second, slightly larger sphere in the same idiom `render/Planet.ts`'s ring
 * uses for "tested but not written" depth reliance: additive, un-lit,
 * fresnel-shaded, depth-tested against `body` so it only survives past the
 * true silhouette. That is `docs/environment.md` §3.2's "bloom is the
 * atmosphere" done as a shader instead of as a scatter of radial strokes —
 * the third and last place this project drew a halo as spokes before
 * catching that a halo is dense at the edge, not radiating from it
 * (`game/comet.ts`'s `COMA_GLOW` comment is the first two).
 *
 * The sector's actual `DirectionalLight`/fill light are owned by `main.ts`,
 * not this file — a light is a property of the *sector*, not of one body in
 * it (`docs/environment.md` §3.1: "every body obeys it"), so a second body
 * added later reads the same light this one does rather than each carrying
 * its own. `render/light.ts`'s `planLight` is still what decides where that
 * light sits and what colour it is; this file only consumes the geometry
 * question, never the physics one.
 */
export const GIANT = {
  // ── placement and scale (§3.5) ────────────────────────────────────────────

  /** Distance from sector centre, dead ahead of spawn. Unchanged from the
   * stroke build's own tuning — `atan(radius/range)*2 ≈ 25°` against
   * `Stage.ts`'s ~88° horizontal FOV, reviewed once already as "frames the
   * ship" rather than "swallows the HUD". A rebuilt medium does not reopen a
   * framing number the medium had nothing to do with. */
  range: 950,
  /** How close the player may get before the body holds station — the same
   * bounded dishonesty `Planet.ts` names and accepts. */
  minRange: 550,
  /** World radius. */
  radius: 215,
  /** Height above the plane. 0: a body this large needs no lift to clear the
   * grid, and centring it on the horizon is what keeps the whole silhouette
   * inside a downward-pitched camera that cannot look up. */
  height: 0,
  /** Radians per second the body turns. First-draft, unflown, same species as
   * every other constant here — on the tuning list once there is something on
   * screen to judge it against. */
  rotationRate: 0.035,

  /**
   * Latitude/longitude divisions on `body`. Raised well past the old shell's
   * 28×20 — that count was chosen because the shell was "barely seen", the
   * detail sitting on strokes drawn on top of it. There is no on-top layer
   * now: this mesh *is* the whole visible surface, so its own tessellation is
   * what stands between a smooth terminator and a faceted one.
   */
  widthSegments: 96,
  heightSegments: 64,

  // ── colour (§4.1, "a genuinely orange Jupiter" — never the Shroud's) ─────

  /** The body's hue anchor, degrees. Narrow rather than the full wheel for
   * the reason `bandSwatches` below inherits unchanged from the stroke
   * build: an unconstrained roll once put this body on `PALETTE.magenta`,
   * the Shroud's own hue, and closing the whole class of mistake beats
   * re-rolling and hoping. */
  baseHueMin: 24,
  baseHueMax: 46,
  /**
   * Per-band colour families, picked by weight rather than jittered off one
   * base hue, for the same reason as before: several named swatches (cream,
   * a pale zone, ochre, rust, deep brown-red) is what "several colours, like
   * the real Jupiter" asked for, and every `saturation` here sits under the
   * hull roster's own floor (`PALETTE.lance` ≈0.61) so a band read in
   * isolation never reads as Raider gold.
   */
  bandSwatches: [
    { hueOffset: 9, saturation: 0.15, lightness: 0.8, weight: 2 }, // cream
    { hueOffset: 4, saturation: 0.27, lightness: 0.62, weight: 3 }, // pale zone
    { hueOffset: 0, saturation: 0.42, lightness: 0.46, weight: 6 }, // ochre
    { hueOffset: -12, saturation: 0.48, lightness: 0.33, weight: 5 }, // rust
    { hueOffset: -18, saturation: 0.38, lightness: 0.2, weight: 2 }, // deep brown-red
  ],

  // ── banding (§3.3, "broad alternating zones and belts") ──────────────────

  /** How many alternating bands span the whole body pole to pole, seeded per
   * sector within this range — "roughly 8-12 across the disc" per the brief,
   * rolled rather than fixed so sector to sector variety survives the
   * rebuild the way it did in the stroke version's belt count. */
  bandCountMin: 8,
  bandCountMax: 12,
  /**
   * How much a band's own angular width shrinks as latitude approaches the
   * pole, applied to `lat` before it is turned into a band index — 0 would
   * give bands of even width everywhere; above 0 narrows them the further
   * out they sit, which is what "narrowing toward the poles" means as a
   * continuous warp rather than a second, separately-tuned band count.
   */
  poleNarrowK: 1.6,
  /** Absolute latitude (0-1, fraction of a right angle) past which the band
   * signal starts blending into the mottled polar cap. */
  poleThreshold: 0.74,
  /** How much further latitude the blend above takes to reach full strength. */
  poleBlendWidth: 0.16,
  /** The cap's own saturation and lightness once the blend above is complete
   * — muted and pale rather than another band colour, so the poles read as
   * "essentially bandless" rather than as one more stripe. */
  poleSaturation: 0.14,
  poleLightness: 0.7,

  /**
   * Two low, integer harmonics of longitude that displace a band boundary's
   * effective latitude — "a slight tilt" made organic rather than straight.
   * Integer on purpose: a non-integer harmonic would not close over the
   * longitude seam, leaving a visible mismatch at `lon = ±π` where the sphere
   * wraps. Scaled by `cosLat` at the call site so the displacement vanishes
   * at the poles — the single point every meridian collapses to, where a
   * longitude-only term would otherwise disagree with itself.
   */
  boundaryWaveAmp1: 0.5,
  boundaryWaveFreq1: 3,
  boundaryWaveAmp2: 0.25,
  boundaryWaveFreq2: 7,

  /** How much the turbulence field (three summed sine octaves, seeded per
   * sector) perturbs a band's own hue and lightness. Deliberately small
   * relative to the gap between two `bandSwatches` entries — turbulence
   * modulates the swatch a vertex already belongs to; it never touches the
   * band index itself, which is what keeps it inside its own band by
   * construction rather than by tuning. */
  turbulenceHueAmp: 5,
  turbulenceLightAmp: 0.07,

  // ── the limb halo (§3.2, "bloom is the atmosphere") ───────────────────────

  /** `limb`'s radius as a multiple of `body`'s. */
  limbScale: 1.03,
  /** Fresnel exponent — higher pulls the glow tighter to the true silhouette. */
  limbPower: 2.6,
  /** Brightness multiplier at full fresnel, before bloom's own threshold.
   * Above 1 on purpose — this is the one place on the body meant to cross
   * it, the mechanism behind "phosphorescent" in the brief. */
  limbIntensity: 1.7,
} as const;

const HALF_PI = Math.PI / 2;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** A cheap, deterministic float from an integer band index and a per-sector
 * salt — a hash, not a draw off `rng`, because a band's colour has to be a
 * pure function of *which band it is*, re-evaluated at every vertex that
 * band owns, not a value consumed once from a sequential cursor. */
function hash1(i: number, salt: number): number {
  const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

type Swatch = (typeof GIANT.bandSwatches)[number];

/** Weighted pick from `GIANT.bandSwatches`, keyed by a hash rather than by
 * `rng.next()` for the reason `hash1` documents. */
function pickSwatch(r: number): Swatch {
  const total = GIANT.bandSwatches.reduce((sum, s) => sum + s.weight, 0);
  let x = r * total;
  for (const swatch of GIANT.bandSwatches) {
    x -= swatch.weight;
    if (x <= 0) return swatch;
  }
  return GIANT.bandSwatches[GIANT.bandSwatches.length - 1];
}

interface Octave {
  /** Integer — see `GIANT.boundaryWaveFreq1`'s comment on why every
   * longitude harmonic in this file has to be one. */
  lonFreq: number;
  latFreq: number;
  phase: number;
  amp: number;
}

/**
 * `limb`'s own material. A minimal fresnel shader rather than a stock
 * material — nothing in three.js's built-in roster multiplies by
 * `1 - dot(normal, viewDir)`, and that term is the entire effect. Computed in
 * view space so it needs no world-space camera position passed in, and reads
 * as "dim at centre, bright at the true edge" without depending on anything
 * this class tracks between frames.
 */
const LIMB_VERTEX = `
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewDir = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const LIMB_FRAGMENT = `
uniform vec3 glowColor;
uniform float power;
uniform float intensity;
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
  float facing = max(dot(normalize(vNormal), normalize(vViewDir)), 0.0);
  float fresnel = pow(1.0 - facing, power);
  gl_FragColor = vec4(glowColor * intensity * fresnel, fresnel);
}
`;

/**
 * One hero gas giant. There is exactly one in the scene, added once in
 * `main.ts` — `docs/environment.md` §6 stage 1 is deliberately one body and
 * nothing else, unchanged by this rebuild.
 */
export class GasGiant {
  readonly object = Object.assign(new Group(), { name: "gas-giant" });

  /** The lit surface. Public so a harness can read its geometry and material
   * directly rather than through an indirection this class would otherwise
   * have to invent just to be testable. */
  body: Mesh | null = null;
  /** The additive limb shell. Same visibility, same reason. */
  limb: Mesh | null = null;

  private key = "";
  /** Where the body sits before the leash. */
  private readonly anchor = new Vector3();

  /**
   * Rebuild for a sector, if it is not already the one standing. Bakes the
   * band pattern once into vertex colours — unlike the stroke build, nothing
   * here has to be recomputed per frame, because a real light reads the
   * terminator off the mesh's own normals and a rigid `rotation.y` carries
   * the baked pattern around with it for free.
   */
  show(seed: number, sector: number): void {
    const key = `${seed}:${sector}`;
    if (key === this.key) return;
    this.key = key;
    this.clear();

    // A hash mix distinct from `planPlanet`'s, `planFixture`'s and
    // `planLight`'s own — reusing any of theirs would correlate the giant's
    // look with another sector feature.
    const rng = makeRng((seed * 3628273133 + sector * 2308142839 + 97354729) >>> 0);

    const hue = GIANT.baseHueMin + rng.next() * (GIANT.baseHueMax - GIANT.baseHueMin);
    const bandCount =
      GIANT.bandCountMin + Math.floor(rng.next() * (GIANT.bandCountMax - GIANT.bandCountMin + 1));
    const swatchSalt = rng.next() * 9973;
    const waveSeed1 = rng.next() * Math.PI * 2;
    const waveSeed2 = rng.next() * Math.PI * 2;
    const octaves: Octave[] = [0.5, 0.3, 0.2].map((amp) => ({
      lonFreq: 2 + Math.floor(rng.next() * 5),
      latFreq: 0.6 + rng.next() * 1.6,
      phase: rng.next() * Math.PI * 2,
      amp,
    }));
    const poleSwatch = GIANT.bandSwatches[0];

    const geometry = new SphereGeometry(GIANT.radius, GIANT.widthSegments, GIANT.heightSegments);
    const position = geometry.attributes.position;
    const colors = new Float32Array(position.count * 3);
    const color = new Color();

    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const nx = x / GIANT.radius;
      const ny = Math.min(1, Math.max(-1, y / GIANT.radius));
      const nz = z / GIANT.radius;
      const lat = Math.asin(ny);
      const lon = Math.atan2(nx, nz);
      const latNorm = lat / HALF_PI;
      const absLat = Math.abs(latNorm);
      const cosLat = Math.cos(lat);

      // Narrows bands toward the pole without changing how many there are —
      // see `GIANT.poleNarrowK`.
      const warpedLat = lat * (1 + GIANT.poleNarrowK * latNorm * latNorm);
      // Vanishes at the pole via `cosLat` — see `GIANT.boundaryWaveFreq1`'s
      // comment for why that is load-bearing, not cosmetic.
      const wobble =
        cosLat *
        (GIANT.boundaryWaveAmp1 * Math.sin(GIANT.boundaryWaveFreq1 * lon + waveSeed1) +
          GIANT.boundaryWaveAmp2 * Math.sin(GIANT.boundaryWaveFreq2 * lon + waveSeed2));
      const phase = warpedLat * bandCount + wobble;
      const idx = Math.floor(phase / Math.PI);
      const swatch = pickSwatch(hash1(idx, swatchSalt));

      // Each octave's longitude term is scaled toward zero as `cosLat`
      // shrinks, so at the exact pole every term collapses to a function of
      // `lat` alone — the same seam-avoidance `wobble` uses above, needed
      // here too because the pole is one point every value of `lon` maps to.
      const lonFade = Math.min(1, cosLat * 6);
      let turb = 0;
      for (const o of octaves) {
        turb += o.amp * Math.sin(o.lonFreq * lon * lonFade + o.latFreq * lat + o.phase);
      }

      let h: number = hue + swatch.hueOffset + turb * GIANT.turbulenceHueAmp;
      let s: number = swatch.saturation;
      let l: number = swatch.lightness + turb * GIANT.turbulenceLightAmp;

      const poleT = smoothstep(GIANT.poleThreshold, GIANT.poleThreshold + GIANT.poleBlendWidth, absLat);
      if (poleT > 0) {
        h = lerp(h, hue + poleSwatch.hueOffset, poleT);
        s = lerp(s, GIANT.poleSaturation, poleT);
        l = lerp(l, GIANT.poleLightness, poleT);
      }

      color.setHSL(
        (((h % 360) + 360) % 360) / 360,
        Math.min(1, Math.max(0, s)),
        Math.min(1, Math.max(0, l)),
        SRGBColorSpace,
      );
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    geometry.setAttribute("color", new BufferAttribute(colors, 3));

    this.body = new Mesh(
      geometry,
      new MeshStandardMaterial({
        vertexColors: true,
        roughness: 1,
        metalness: 0,
        // The body lives 640-1160 units out — well past `Stage`'s 260-unit
        // fog far plane. Without this the whole mesh fades toward the
        // scene's black fog colour and a solid, lit sphere disappears the
        // same way an additive stroke used to. See `VectorObject`'s own
        // header; this is the same trap, hit a second time on a different
        // material family.
        fog: false,
      }),
    );
    // Below the ships and below `Planet`'s own render order — this body is
    // further out and larger, so it should lose any coincident overlap to
    // everything nearer.
    this.body.renderOrder = -1.98;

    const haloColor = new Color().setHSL(
      hue / 360,
      Math.min(0.5, GIANT.bandSwatches[2].saturation + 0.1),
      0.74,
      SRGBColorSpace,
    );
    this.limb = new Mesh(
      new SphereGeometry(
        GIANT.radius * GIANT.limbScale,
        Math.max(32, Math.floor(GIANT.widthSegments / 2)),
        Math.max(24, Math.floor(GIANT.heightSegments / 2)),
      ),
      new ShaderMaterial({
        uniforms: {
          glowColor: { value: haloColor },
          power: { value: GIANT.limbPower },
          intensity: { value: GIANT.limbIntensity },
        },
        vertexShader: LIMB_VERTEX,
        fragmentShader: LIMB_FRAGMENT,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        // Tested and load-bearing, not a default left alone: with this off,
        // `limb` draws its whole disc rather than only the sliver past
        // `body`'s own silhouette that depth-testing against it produces.
        depthTest: true,
        side: FrontSide,
        // A hand-written shader gets no automatic fog unless it opts in —
        // this one never does, which is the same exemption `fog: false`
        // above spends a property to state explicitly.
        fog: false,
      }),
    );
    // Child of `body` so it inherits the same rigid rotation for free —
    // the shader's own fresnel term depends only on the normal and the view
    // direction, both recomputed every frame regardless of orientation, so
    // there is nothing to keep in sync by parenting it here instead of
    // beside it.
    this.body.add(this.limb);
    this.object.add(this.body);

    // Fixed bearing 0 (+Z, dead ahead of spawn heading) — unchanged from the
    // stroke build: this body is stage 1 of `docs/environment.md` §6,
    // "the owner looks at it before anything is planned around it," and a
    // prototype that might roll behind the player at the moment someone
    // presses a key to check it would be testing nothing.
    this.anchor.set(0, GIANT.height, GIANT.range);
    this.object.position.copy(this.anchor);
    // A seeded starting spin so the same sector does not always present the
    // same face.
    this.body.rotation.y = rng.next() * Math.PI * 2;
  }

  /** Hold station if the player has come too close — unchanged leash logic
   * from the stroke build and from `Planet.ts` before it. */
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

  /** Axial rotation, §3.6 — the whole mechanism the brief specifies:
   * `mesh.rotation.y += rate * dt`. Nothing else moves, because the banding
   * is baked geometry now rather than strokes rebuilt every frame. */
  update(dt: number): void {
    if (!this.body) return;
    this.body.rotation.y += GIANT.rotationRate * dt;
  }

  /** Torn down on a sector change, the same moment `Planet.clear` and
   * `Comet.clear` are. */
  clear(): void {
    if (this.limb) {
      this.limb.geometry.dispose();
      (this.limb.material as ShaderMaterial).dispose();
    }
    if (this.body) {
      this.body.geometry.dispose();
      (this.body.material as MeshStandardMaterial).dispose();
    }
    this.body = null;
    this.limb = null;
    for (const child of [...this.object.children]) this.object.remove(child);
  }
}
