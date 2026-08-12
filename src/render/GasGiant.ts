import { Color, Group, SphereGeometry, SRGBColorSpace, Vector3 } from "three";
import { makeRng } from "../chart/rng.js";
import { shadeAt, type SectorLight } from "./light.js";
import type { TraceBuffer } from "./TraceBuffer.js";
import { VectorObject } from "./VectorObject.js";

/**
 * The hero gas giant — `docs/environment.md` §3, stage 1 of the plan. Not one
 * of eight bodies; **one**, built as a throwaway-visible prototype, because
 * the question this file exists to answer — does density plus a real light
 * plus bloom read as *weather on a sphere lit by a star*, or as a wireframe
 * ball with stripes — is cheapest to answer once. See the spec's own §8,
 * "the medium may not carry it": this is the whole bet, at the price of one
 * body.
 *
 * **The two-mechanism split, §5.1 of the spec, is why this file has both a
 * `VectorObject` and a `draw(trace)` method instead of just the first.**
 * `VectorObject` bakes vertex colours at construction — right for a hull,
 * whose brightness never changes, wrong for a body that rotates under a
 * fixed light, whose lit side *moves*. So:
 *
 * - **The shell** (`this.shell`, built in `show`) is a low-poly occluded
 *   sphere. Its only jobs are to write depth, so the body eats the starfield
 *   behind it (§3.4), and to give the silhouette. Uniform, dim, barely seen —
 *   the detail sits on top of it, never on it.
 * - **Everything with a shape** — the belts, the storm, the limb halo — is
 *   rebuilt from scratch into `skyTrace` every `draw` call, exactly the
 *   comet's plume technique (`game/comet.ts`, read before this file was
 *   written): connected chains rather than loose dashes, a fade at both ends,
 *   density over count. That is what makes rotation free (advance `longitude`
 *   and the next frame's strokes land in new places) and lighting a per-
 *   stroke multiply (`shadeAt`) rather than something baked once and stale
 *   forever after.
 *
 * **Fixed bearing, not seeded.** Every other body in this codebase
 * (`Planet.ts`, `game/comet.ts`) places itself at a seeded bearing so a
 * sector's furniture varies. This one does not: stage 1's entire job is to be
 * looked at (spec §6, step 1 — "the owner looks at it before anything is
 * planned around it"), and a prototype that might roll a bearing behind the
 * player at the moment someone presses a key to check it would be testing
 * nothing. `seed`/`sector` still drive the belts, the storm and the hue, so
 * the look still varies sector to sector — only the position is pinned, dead
 * ahead of the ship's spawn heading (`+Z`, bearing 0). A later stage that
 * wants a seeded bearing for "one hero per sector" is exactly the kind of
 * choice `docs/environment.md` §6 defers past this one.
 *
 * **No live camera parameter.** `draw(trace)` takes only the buffer, per the
 * brief's interface, so "only draw the near hemisphere" (spec step 2) is
 * culled against `viewDir` — the direction from the body to the *player*,
 * cached by `follow` — rather than the camera. The two are always within a
 * few units of each other (`placeCamera`'s widest offset is chase mode's 12
 * units back) against a body hundreds of units away, so the approximation is
 * exact enough for a hemisphere test and it means `follow` never has to wait
 * for `placeCamera` to run first, unlike `Backdrop.follow(stage.camera)`.
 */
export const GIANT = {
  // ── placement and scale (§3.5) ────────────────────────────────────────────

  /**
   * Distance from sector centre, dead ahead of spawn. Chosen, with `radius`,
   * so the body reads as roughly a third of the horizontal field of view
   * (`Stage.ts`'s 62° vertical FOV is ~88° horizontal at a 1280×800 aspect):
   * `atan(radius / range) * 2` ≈ 32° here, against an 88° frame. Comfortably
   * inside the 2000 far plane with the leash never engaging until the player
   * genuinely closes distance.
   */
  range: 900,
  /**
   * How close the player may get before the body holds station — the same
   * dishonesty `Planet.ts` accepts and names: real parallax right up until
   * this point, then a held distance rather than a flight through the body.
   * 520, giving ~400 units (44% of `range`) of genuine approach, enough for
   * the size change to read as real perspective rather than a tween.
   */
  minRange: 520,
  /** World radius. See `range` for the framing this is chosen against. */
  radius: 260,
  /**
   * Height above the plane. 0, not `Planet.height`'s 210 — a body this large
   * needs no lift to clear the grid, and centring it on the horizon is what
   * keeps the whole silhouette inside a downward-pitched camera's frame
   * without ever asking the game to look up (`CLAUDE.md`'s recurring warning;
   * `PLANET.height`'s own comment is the fourth file to record it).
   */
  height: 0,
  /** Latitude/longitude divisions on the shell. Low, on purpose — this is a
   * stroke renderer and the shell is barely seen; the detail is on top of it. */
  shellSegments: 20,
  shellRings: 14,
  /** Radians per second the body turns. First-draft guess, unflown, same
   * species as every other constant here — on the tuning list once there is
   * something on screen to judge it against. */
  rotationRate: 0.035,

  // ── the belts (§3.3, "hundreds of arcs, not eight stripes") ──────────────

  /**
   * Distinct latitude bands. Each is not one continuous line around the
   * whole sphere — see `filamentsPerBand` for why — so the true stroke
   * count this produces is well past "hundreds" before a single segment is
   * walked. Same lesson the comet's rewrite recorded: 40 dashes read as
   * scatter, ~500 connected filaments read as gas. If this number can be
   * counted at a glance in the finished render, it is too low.
   */
  bandCount: 70,
  /** Latitude band the belts are drawn across, radians either side of the
   * equator. Kept off the poles — a belt wrapped tight around a pole reads as
   * a cap, not a band. */
  beltLatitudeRange: 1.1,
  /**
   * Short filaments per band, each covering only a fraction of the full
   * circumference (`filamentSpanMin`/`Max`) rather than one continuous line
   * all the way round. This is the same correction the comet's own plume
   * needed and for the same reason, recorded in `game/comet.ts`'s
   * `COMET.filaments` comment: one line per belt, walked start to finish,
   * reads as taut wire — the visible hemisphere is one smooth stroke with a
   * hard start and a hard stop at the horizon, and forty of those read as a
   * wireframe cage, not weather. Several shorter, overlapping filaments per
   * band, each fading to nothing at both of its own ends
   * (`filamentFadeIn`/`Out`), is what gave the comet's tail depth instead of
   * a bundle of straight lines, and the same fix applies here.
   */
  filamentsPerBand: 5,
  /** How much a band's filament count is allowed to jitter, seeded per band
   * — some bands read sparser than others, which is itself part of not
   * looking like a uniform grid. */
  filamentCountJitter: 2,
  /** Fraction of the full circumference (0-1, i.e. of 2π) one filament
   * spans, before the per-filament jitter below widens or narrows it. */
  filamentSpanMin: 0.18,
  filamentSpanMax: 0.4,
  /** Steps a single filament is walked in. Short — these are meant to be
   * short strokes, not the whole belt. */
  filamentSteps: 15,
  /** How much of a filament's own span fades in at its leading edge and out
   * at its trailing one, 0-1. The single most important number for whether
   * this reads as gas rather than wire — see `filamentsPerBand`'s comment
   * and `game/comet.ts`'s `FILAMENT_FADE_IN`/`FILAMENT_FADE_OUT`, which this
   * mirrors: tapering both ends to nothing is what stops every filament from
   * announcing a visible line-end, so the eye integrates the overlap into
   * something with no edges instead of counting threads.
   */
  filamentFadeIn: 0.22,
  filamentFadeOut: 0.3,
  /**
   * Radians a band's centre line drifts, linearly, across a filament's own
   * span — "a slight tilt" per the brief, distinct from the sinusoidal
   * wobble below. Small: this is a gentle incline, not a spiral.
   */
  beltTilt: 0.12,
  /** Turbulence — the sinusoidal wobble in latitude that shears with
   * longitude, per the brief. Amplitude range and the frequency band below it
   * are what turns a belt from a hoop into weather. */
  wobbleAmpMin: 0.02,
  wobbleAmpMax: 0.09,
  wobbleFreqMin: 1.5,
  wobbleFreqMax: 4.5,
  /** How far a band's individual filaments scatter off its centre latitude,
   * radians — "a width" per the brief. Several filaments landing at
   * slightly different latitudes within this spread is what reads as a
   * filled band; a single hairline would not. */
  beltWidthMin: 0.02,
  beltWidthMax: 0.1,
  /** How far off the base hue an individual band's tint drifts, degrees.
   * Band to band variation is what stops the whole body reading as one flat
   * wash of colour under the shading. */
  hueJitterDeg: 18,
  /**
   * Below this, a segment is skipped rather than pushed — the same guard the
   * comet's plume uses (`level > 0.02`) so a segment faded to nothing does
   * not spend a slot in the buffer for a stroke nobody would see anyway.
   */
  minLevel: 0.02,
  /**
   * How close to the exact silhouette (`facing`, the dot of the surface
   * normal and `viewDir`) a belt segment fades in from, 0-1. Without this the
   * strokes stop dead at the horizon in a single frame's step rather than
   * feathering into the shell's own silhouette edge.
   */
  hemisphereFadeIn: 0.14,
  /**
   * The radius belt strokes are actually drawn at, as a multiple of `radius`.
   * Fractionally outside the shell's own surface so the strokes never
   * z-fight the depth the shell writes at exactly `radius` — the same problem
   * `VectorObject`'s `polygonOffset` solves for a hull's edges against its
   * own hull.
   */
  beltRadiusBias: 1.012,

  // ── the storm (§3.3, "one storm oval") ────────────────────────────────────

  /** Concentric rings drawn to give the storm a filled, not outlined, look. */
  stormRings: 4,
  /** How much each successive ring shrinks toward the storm's centre. */
  stormRingStep: 0.22,
  /** Steps per ring. */
  stormSteps: 28,
  /** Angular half-extent of the storm in latitude and longitude, radians —
   * an oval, not a circle, which is what keeps it reading as weather rather
   * than a second, smaller planet stuck to the first. */
  stormHalfLat: 0.16,
  stormHalfLon: 0.26,
  /** Degrees the storm's hue sits from the base — a genuine accent rather
   * than another belt, the way a real gas giant's one great storm stands out
   * from its banding. */
  stormHueOffset: 150,

  // ── the limb halo (§3.2, "bloom is the atmosphere") ───────────────────────

  /** Strokes around the silhouette. The whole ring is drawn — unlike the
   * belts, the limb *is* the near-hemisphere boundary, so there is nothing to
   * cull. */
  limbCount: 150,
  /** Radial steps each limb stroke fans outward through, densest near the
   * body and fading out — this is the brightness distribution bloom turns
   * into atmosphere; see the file header and spec §3.2. */
  limbSteps: 3,
  /** How far outside `radius` the halo reaches, as a fraction of it. */
  limbDepth: 0.22,
  /** Peak brightness multiplier at the base of the halo, before `shadeAt`'s
   * own falloff and the radial fade. Above 1 on purpose — bloom keys off
   * intensity past a threshold, and this is the one place in the body meant
   * to cross it. */
  limbBrightness: 1.6,
} as const;

const UP = new Vector3(0, 1, 0);
const RIGHT = new Vector3(1, 0, 0);

/** One short filament within a band — see `GIANT.filamentsPerBand` for why a
 * band is several of these rather than one continuous line. */
interface Filament {
  /** Where it starts, as a fraction of the full circumference (0-1). */
  startLon: number;
  /** How far it reaches from `startLon`, same units. */
  span: number;
  /** Latitude offset from the band's own centre, radians. */
  latOffset: number;
}

/** One band's shape, fixed at `show` time. Only the body's `longitude`
 * changes what world position it draws at — see the file header on why that
 * is what makes rotation free. */
interface Belt {
  baseLat: number;
  tilt: number;
  wobbleAmp: number;
  wobbleFreq: number;
  phase: number;
  brightness: number;
  color: Color;
  filaments: Filament[];
}

interface Storm {
  lat: number;
  lon: number;
  brightness: number;
  color: Color;
}

/**
 * One hero gas giant. There is exactly one in the scene, added once in
 * `main.ts` — this is not a per-kind factory the way `Fleet`'s hostiles are,
 * because stage 1 (`docs/environment.md` §6) is deliberately one body and
 * nothing else.
 */
export class GasGiant {
  readonly object = Object.assign(new Group(), { name: "gas-giant" });

  /** Current rotation, radians, advanced by `update`. Public because the
   * brief's own harness reads it directly to prove rotation is happening —
   * see `tools/playtest.mjs`. */
  longitude = 0;

  private key = "";
  private shell: VectorObject | null = null;
  private light: SectorLight | null = null;
  private readonly belts: Belt[] = [];
  private storm: Storm | null = null;
  private haloColor = new Color();

  /** Where the body sits before the leash. */
  private readonly anchor = new Vector3();
  /** Direction from the body to the player, refreshed by `follow`. Defaults
   * to "toward spawn" so a `draw` called before the first `follow` (should
   * never happen in practice, but costs nothing to make safe) still culls
   * against something sane rather than the zero vector. */
  private readonly viewDir = new Vector3(0, 0, -1);

  // Scratch, reused every stroke rather than allocated per one — see the
  // file header and `render/light.ts`'s own header on why `shadeAt`'s call
  // sites have to stay allocation-free too.
  private readonly scratchPoint = new Vector3();
  private readonly scratchNormal = new Vector3();
  private readonly u = new Vector3();
  private readonly v = new Vector3();

  /**
   * Rebuild for a sector, if it is not already the one standing. `light` is
   * reassigned unconditionally — cheap, a pointer copy, and a sector's star
   * does not move once `planLight` has placed it, so there is nothing to
   * gain by gating it behind the same key.
   */
  show(seed: number, sector: number, light: SectorLight): void {
    this.light = light;
    const key = `${seed}:${sector}`;
    if (key === this.key) return;
    this.key = key;
    this.clear();

    // A hash mix distinct from `planPlanet`'s, `planFixture`'s and
    // `planLight`'s own — reusing any of theirs would correlate the giant's
    // look with another sector feature, the exact furniture problem each of
    // those files' own comments warn against.
    const rng = makeRng((seed * 3628273133 + sector * 2308142839 + 97354729) >>> 0);

    const hue = rng.next() * 360;
    const saturation = 0.5 + rng.next() * 0.3;

    this.shell = new VectorObject(
      new SphereGeometry(GIANT.radius, GIANT.shellSegments, GIANT.shellRings),
      {
        color: new Color().setHSL(hue / 360, saturation * 0.6, 0.3, SRGBColorSpace),
        linewidth: 1.2,
        // The body lives 640-1160 units out — well past `Stage`'s 260-unit
        // fog far plane. Without this the shell's edges fog to the scene's
        // black and vanish, and the only thing left on screen is a
        // depth-only hole in the starfield. See `VectorObject`'s own header.
        fog: false,
      },
    );
    // Below the ships and below `Planet`'s own render order (-1.97/-1.96) —
    // this body is further out and larger, so it should lose any coincident
    // overlap to everything nearer.
    this.shell.group.traverse((child) => {
      child.renderOrder = -1.98;
    });
    this.object.add(this.shell.group);

    for (let i = 0; i < GIANT.bandCount; i++) {
      const beltHue = hue + (rng.next() * 2 - 1) * GIANT.hueJitterDeg;
      const width = GIANT.beltWidthMin + rng.next() * (GIANT.beltWidthMax - GIANT.beltWidthMin);

      const filamentCount = Math.max(
        1,
        GIANT.filamentsPerBand + Math.round((rng.next() * 2 - 1) * GIANT.filamentCountJitter),
      );
      const filaments: Filament[] = [];
      for (let f = 0; f < filamentCount; f++) {
        filaments.push({
          startLon: rng.next(),
          span: GIANT.filamentSpanMin + rng.next() * (GIANT.filamentSpanMax - GIANT.filamentSpanMin),
          latOffset: (rng.next() * 2 - 1) * width,
        });
      }

      this.belts.push({
        baseLat: (rng.next() * 2 - 1) * GIANT.beltLatitudeRange,
        tilt: (rng.next() * 2 - 1) * GIANT.beltTilt,
        wobbleAmp: GIANT.wobbleAmpMin + rng.next() * (GIANT.wobbleAmpMax - GIANT.wobbleAmpMin),
        wobbleFreq: GIANT.wobbleFreqMin + rng.next() * (GIANT.wobbleFreqMax - GIANT.wobbleFreqMin),
        phase: rng.next() * Math.PI * 2,
        brightness: 0.55 + rng.next() * 0.45,
        color: new Color().setHSL((((beltHue % 360) + 360) % 360) / 360, saturation, 0.4 + rng.next() * 0.3, SRGBColorSpace),
        filaments,
      });
    }

    this.storm = {
      lat: (rng.next() * 2 - 1) * GIANT.beltLatitudeRange * 0.7,
      lon: rng.next() * Math.PI * 2,
      brightness: 1.1,
      color: new Color().setHSL(((hue + GIANT.stormHueOffset) % 360) / 360, saturation, 0.55, SRGBColorSpace),
    };

    this.haloColor = new Color().setHSL(hue / 360, Math.min(1, saturation + 0.15), 0.72, SRGBColorSpace);

    // Fixed bearing 0 (+Z, dead ahead of spawn heading) — see the file
    // header for why this body does not roll a seeded bearing the way
    // `Planet.ts` does.
    this.anchor.set(0, GIANT.height, GIANT.range);
    this.object.position.copy(this.anchor);
    // A seeded starting spin so the same sector does not always present the
    // same face — cheap variety, since nothing about the belts themselves
    // depends on where `longitude` starts.
    this.longitude = rng.next() * Math.PI * 2;
  }

  /**
   * Hold station if the player has come too close, and cache the direction
   * back to the player for `draw`'s hemisphere cull. See the file header for
   * why this reads the player rather than the camera, and why that means it
   * never has to wait for `placeCamera` the way `Backdrop.follow` does.
   */
  follow(player: Vector3): void {
    if (!this.shell) return;
    const dx = this.anchor.x - player.x;
    const dz = this.anchor.z - player.z;
    const flat = Math.hypot(dx, dz);
    if (flat >= GIANT.minRange || flat < 1e-3) {
      this.object.position.copy(this.anchor);
    } else {
      const push = GIANT.minRange / flat;
      this.object.position.set(player.x + dx * push, GIANT.height, player.z + dz * push);
    }

    this.viewDir.set(
      player.x - this.object.position.x,
      player.y - this.object.position.y,
      player.z - this.object.position.z,
    );
    const len = this.viewDir.length();
    if (len > 1e-3) this.viewDir.multiplyScalar(1 / len);
  }

  /** Axial rotation, §3.6 — a longitude offset advanced by `dt`. Because the
   * belts are rebuilt from scratch every `draw` call, this is the entire
   * cost of rotation; nothing else has to change. */
  update(dt: number): void {
    this.longitude = (this.longitude + GIANT.rotationRate * dt) % (Math.PI * 2);
  }

  /**
   * Every stroke of surface detail, pushed into `trace` at intensity
   * `shadeAt` computes for that exact point and normal. Regenerated in full
   * every call and nothing here persists between them — the comet's own
   * contract (`game/comet.ts`'s `Comet.draw`).
   */
  draw(trace: TraceBuffer): void {
    if (!this.shell || !this.light) return;
    const light = this.light;
    const center = this.object.position;
    const radius = GIANT.radius;

    this.drawBelts(trace, light, center, radius);
    this.drawStorm(trace, light, center, radius);
    this.drawHalo(trace, light, center, radius);
  }

  /**
   * Each band as several short, overlapping filaments rather than one line
   * all the way round — see `GIANT.filamentsPerBand`'s comment for why a
   * single continuous stroke reads as wire and this does not.
   */
  private drawBelts(trace: TraceBuffer, light: SectorLight, center: Vector3, radius: number): void {
    const steps = GIANT.filamentSteps;
    for (const belt of this.belts) {
      for (const filament of belt.filaments) {
        let hasPrev = false;
        let px = 0;
        let py = 0;
        let pz = 0;

        for (let k = 0; k <= steps; k++) {
          const u = k / steps;
          const theta0 = (filament.startLon + filament.span * u) * Math.PI * 2;
          const lat =
            belt.baseLat +
            filament.latOffset +
            belt.tilt * (theta0 - Math.PI) +
            belt.wobbleAmp * Math.sin(belt.wobbleFreq * theta0 + belt.phase);
          const theta = theta0 + this.longitude;
          const cosLat = Math.cos(lat);
          const nx = cosLat * Math.sin(theta);
          const ny = Math.sin(lat);
          const nz = cosLat * Math.cos(theta);

          const facing = nx * this.viewDir.x + ny * this.viewDir.y + nz * this.viewDir.z;
          if (facing <= 0) {
            hasPrev = false;
            continue;
          }

          const x = center.x + nx * radius * GIANT.beltRadiusBias;
          const y = center.y + ny * radius * GIANT.beltRadiusBias;
          const z = center.z + nz * radius * GIANT.beltRadiusBias;

          if (hasPrev) {
            this.scratchNormal.set(nx, ny, nz);
            this.scratchPoint.set(x, y, z);
            const lit = shadeAt(light, this.scratchPoint, this.scratchNormal);
            const edgeFade = Math.min(1, facing / GIANT.hemisphereFadeIn);
            // Tapers to nothing at both of the filament's own ends — see
            // `GIANT.filamentFadeIn`'s comment for why this, not the
            // hemisphere fade alone, is what stops the belts reading as wire.
            const ends = Math.min(1, u / GIANT.filamentFadeIn, (1 - u) / GIANT.filamentFadeOut);
            const level = lit * belt.brightness * edgeFade * ends;
            if (level > GIANT.minLevel) trace.push(px, py, pz, x, y, z, belt.color, level);
          }

          px = x;
          py = y;
          pz = z;
          hasPrev = true;
        }
      }
    }
  }

  private drawStorm(trace: TraceBuffer, light: SectorLight, center: Vector3, radius: number): void {
    const storm = this.storm;
    if (!storm) return;
    const steps = GIANT.stormSteps;

    for (let ring = 0; ring < GIANT.stormRings; ring++) {
      const scale = 1 - ring * GIANT.stormRingStep;
      let hasPrev = false;
      let px = 0;
      let py = 0;
      let pz = 0;

      for (let k = 0; k <= steps; k++) {
        const t = (k / steps) * Math.PI * 2;
        const lat = storm.lat + Math.sin(t) * GIANT.stormHalfLat * scale;
        const theta = storm.lon + this.longitude + Math.cos(t) * GIANT.stormHalfLon * scale;
        const cosLat = Math.cos(lat);
        const nx = cosLat * Math.sin(theta);
        const ny = Math.sin(lat);
        const nz = cosLat * Math.cos(theta);

        const facing = nx * this.viewDir.x + ny * this.viewDir.y + nz * this.viewDir.z;
        if (facing <= 0) {
          hasPrev = false;
          continue;
        }

        const x = center.x + nx * radius * GIANT.beltRadiusBias;
        const y = center.y + ny * radius * GIANT.beltRadiusBias;
        const z = center.z + nz * radius * GIANT.beltRadiusBias;

        if (hasPrev) {
          this.scratchNormal.set(nx, ny, nz);
          this.scratchPoint.set(x, y, z);
          const lit = shadeAt(light, this.scratchPoint, this.scratchNormal);
          const edgeFade = Math.min(1, facing / GIANT.hemisphereFadeIn);
          const level = lit * storm.brightness * edgeFade;
          if (level > GIANT.minLevel) trace.push(px, py, pz, x, y, z, storm.color, level);
        }

        px = x;
        py = y;
        pz = z;
        hasPrev = true;
      }
    }
  }

  /** The bloom-catching rim, §3.2. Drawn all the way around the silhouette
   * — see `GIANT.limbCount`'s comment for why there is nothing to cull here. */
  private drawHalo(trace: TraceBuffer, light: SectorLight, center: Vector3, radius: number): void {
    this.u.crossVectors(UP, this.viewDir);
    if (this.u.lengthSq() < 1e-6) this.u.crossVectors(RIGHT, this.viewDir);
    this.u.normalize();
    this.v.crossVectors(this.viewDir, this.u);

    for (let i = 0; i < GIANT.limbCount; i++) {
      const angle = (i / GIANT.limbCount) * Math.PI * 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const dx = this.u.x * c + this.v.x * s;
      const dy = this.u.y * c + this.v.y * s;
      const dz = this.u.z * c + this.v.z * s;

      this.scratchNormal.set(dx, dy, dz);
      let px = center.x + dx * radius;
      let py = center.y + dy * radius;
      let pz = center.z + dz * radius;
      this.scratchPoint.set(px, py, pz);
      const lit = shadeAt(light, this.scratchPoint, this.scratchNormal);

      for (let r = 1; r <= GIANT.limbSteps; r++) {
        const rad = radius * (1 + (GIANT.limbDepth * r) / GIANT.limbSteps);
        const x = center.x + dx * rad;
        const y = center.y + dy * rad;
        const z = center.z + dz * rad;
        const fall = 1 - (r - 1) / GIANT.limbSteps;
        const level = lit * GIANT.limbBrightness * fall;
        if (level > GIANT.minLevel) trace.push(px, py, pz, x, y, z, this.haloColor, level);
        px = x;
        py = y;
        pz = z;
      }
    }
  }

  setMode(mode: Parameters<VectorObject["setMode"]>[0]): void {
    this.shell?.setMode(mode);
  }

  /** Torn down on a sector change, the same moment `Planet.clear` and
   * `Comet.clear` are. */
  clear(): void {
    this.shell?.dispose();
    this.shell = null;
    this.belts.length = 0;
    this.storm = null;
    this.light = null;
    for (const child of [...this.object.children]) this.object.remove(child);
  }
}
