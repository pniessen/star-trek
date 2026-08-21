import {
  AdditiveBlending,
  BackSide,
  Color,
  Euler,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  Object3D,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { flowLadder } from "./shaders/noise.js";
import { BAKE, NebulaBake, type NebulaBakePlan, type NebulaBakeTuning } from "./NebulaBake.js";

/**
 * The haze — rebuild three, and the one that has an inside.
 *
 * Rebuild one was strokes, and `Backdrop.ts` still carries its own honest
 * confession: "a nebula is diffuse and diffuse is the one thing strokes cannot
 * do". Rebuild two was this file's first fragment shader, which took the gas
 * giant's answer — give up on strokes, use a shader — and got a genuinely
 * better sky out of it. It was also, in its own words, *a pattern painted on a
 * sphere*: one analytic layer, sampled once per direction, with no interior at
 * all.
 *
 * # What the interior buys, and why nothing else does
 *
 * **Depth ordering inside the medium.** A painted layer blends a warm colour
 * and a cool one by density; every pixel is one sample of one field, so there
 * is no front and no behind, and the single most recognisable thing about a
 * real nebula — *dark dust silhouetted in front of bright gas* — is not
 * expressible at all. It is not a matter of tuning the blend. A dust lane
 * painted into a density field can only ever be a place where the paint is
 * darker, which is why the old version read as coloured fog no matter what the
 * knobs did.
 *
 * Front-to-back accumulation through a real 3D field expresses it for free, and
 * it also gets three things this file previously had no way to say: separate
 * **emission**, **scattering** and **absorption** channels rather than one
 * blended tint (see `NebulaBake.ts` — H-alpha crimson and O III teal from
 * ionised gas, blue from dust scattering starlight, near-black from dust
 * absorbing it, and the absorption is wavelength-dependent so what comes
 * through a lane is *reddened*); an **embedded star** carving a cavity and
 * lighting its walls from inside, which is the whole reason the Pillars and the
 * Trapezium look the way they do; and **curl-noise filaments**, so the wisps
 * read as gas that has been sheared rather than as clouds.
 *
 * # Why it is a bake, and what stays live
 *
 * That integral cannot run per-frame at any quality worth having, and a cubemap
 * cannot be sharp enough to stand alone — a 1024px face is 11 pixels a degree
 * against a display's 36. So the resolution is a hybrid and each half does what
 * it is good at:
 *
 *  - **Baked, once a sector, into a cubemap:** the low-frequency volumetric
 *    structure. Depth ordering, the three channels, the star's cavity and its
 *    shadows. All of it inherently soft, so a soft cubemap loses nothing.
 *  - **Live, per fragment, at screen resolution:** a cheap high-frequency
 *    detail layer. It *modulates* the baked radiance rather than adding to it,
 *    which is the property that matters — detail painted onto a dust-shadowed
 *    region stays dark, so the sharpness arrives without disturbing the
 *    ordering the bake computed.
 *
 * `detail`, `warp` and `detailAmount` therefore move with no rebake at all,
 * which also makes them the three knobs on the console that respond instantly.
 *
 * # It still shares the sky's own frame
 *
 * `pole` and `lane` still come from `Backdrop`'s plan rather than from a roll of
 * this module's own — the bake is done in the sky group's local frame, so the
 * band, the lane and the star field are one sky and the group's slow wheel and
 * hyperwarp tear apply to the volume for free. `Backdrop.plane` hands the lane
 * over already converted to radians — its own plan stores degrees — so nothing
 * here converts it a second time.
 *
 * # One thing this class has to defend itself against
 *
 * `Backdrop.clear()` removes *and disposes* every child of its group on every
 * sector change, and `main.ts` parents this group there. That is a perfectly
 * reasonable thing for the backdrop to do about its own contents — it rebuilds
 * them from a fresh plan — and it is fatal to a lodger. Measured on the shipped
 * wiring: after the first `sky.show`, the nebula group is not in the scene
 * graph at all, so the haze was not being drawn. Neither of those two files is
 * mine to edit, so this one re-attaches itself in `sync` (which `main.ts` calls
 * immediately after `sky.show`, so the gap never survives to a frame) and keeps
 * its material and geometry from being freed underneath it. See `home` and
 * `releaseGpu`.
 */
export const NEBULA = {
  /**
   * Peak output. Judged on screen against the stroke HUD drawn through the same
   * bloom — `Stage`'s soft knee and `ToneMapPass`'s highlight rolloff make the
   * old hard "stay under 0.5 linear" rule looser than it was, but a sky that
   * blooms is a sky that eats the instruments.
   */
  brightness: 0.8,
  /**
   * Half-thickness of the *gas disc*, in bake units, and no longer a gaussian
   * in latitude. An observer inside a plane-parallel slab sees a column that
   * goes as 1/sin(latitude), so the band's shape now falls out of being inside
   * the thing rather than being a profile chosen to look like one. The number
   * means roughly the same thing it always did: the sine of the latitude at
   * which the band has thinned out.
   */
  bandWidth: 0.34,
  /**
   * How much dust there is, which is now literally an extinction coefficient
   * rather than a subtraction from a brightness. At 0 the medium is
   * transparent and the sky is pure emission; at 1 the lane genuinely eats what
   * is behind it and reddens what gets through. Still THE number.
   */
  laneDepth: 0.85,
  /** Dust disc thickness as a fraction of the gas disc. Thinner than the glow it cuts. */
  laneWidth: 0.36,
  /**
   * Frequency of the **live** high-frequency layer. Higher is finer.
   *
   * This governs the screen-resolution detail only — the bake's own frequencies
   * are compiled in, because they set the scale of the volume relative to the
   * march and changing them changes what the volume *is*. That split is why
   * this knob answers instantly.
   */
  detail: 9,
  /** Domain warp on the live layer. Curls and festoons at height; a smudge at zero. */
  warp: 1.35,
  /** Floor under the whole sky, so away from the plane it is deep rather than black. */
  ambient: 0.03,

  // --- new with the volume; see the report for the ranges each wants ---

  /**
   * Overall multiplier on dust extinction, on top of `laneDepth`.
   *
   * The knob for the property this rebuild exists for: at 0 nothing occludes
   * anything and the volume collapses back to a sum, which is exactly the old
   * painted look and is worth being able to A/B against. At 1 dust in front of
   * gas is dust in front of gas.
   */
  depth: 1,
  /**
   * Curl-warp amplitude in the bake. At 0 the medium is fBm and reads as
   * weather; at 1 it has been sheared along a divergence-free flow and reads as
   * something that was pulled.
   */
  filament: 1,
  /** Gain on channel (a), ionised gas emitting. */
  emission: 1,
  /** Gain on channel (b), dust scattering starlight. */
  scatter: 1,
  /** The embedded star's luminosity — how hard it lights its own cavity walls. */
  starPower: 1,
  /** Cavity radius as a fraction of the cloud. A blown hole, or a star in fog. */
  cavity: 0.6,
  /** How hard the live layer bites into the bake. */
  detailAmount: 0.42,
  /** O III against H-alpha. Teal near the star at 1; all crimson at 0. */
  teal: 0.55,

  /** Sphere radius. Well inside `Stage`'s 2000 far plane; it is camera-pinned. */
  radius: 900,
};

/** How long a bake-affecting knob must sit still before the queue restarts. */
const REBAKE_DELAY = 0.18;

/** Deterministic and its own mix, so the nebula never correlates with another feature. */
function hash(seed: number, sector: number, salt: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (sector + 0x165667b1), 0xc2b2ae35);
  h = Math.imul(h ^ (salt * 0x27d4eb2f), 0x165667b1);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function approach(value: number, target: number, seconds: number, dt: number): number {
  const step = seconds <= 0 ? 1 : dt / seconds;
  const delta = target - value;
  return Math.abs(delta) <= step ? target : value + Math.sign(delta) * step;
}

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  // Local position on the sphere *is* the direction, which is all this shader
  // wants — and it is the same frame the volume was baked in, so the cube
  // lookup below needs no matrix at all and stays correct under the sky group's
  // own rotation.
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
// GLSL ES 1.00 defaults samplers to lowp, which would quantise a half-float HDR
// cube into bands. Stated rather than assumed.
precision highp samplerCube;

varying vec3 vDir;

uniform samplerCube uPreview;
uniform samplerCube uFull;
uniform float uFullMix;
uniform float uReady;

uniform float uBrightness;
uniform float uDetail;
uniform float uWarp;
uniform float uDetailAmount;
uniform float uAmbient;
uniform float uSeed;

uniform vec3 uPole;
uniform float uGasH;
uniform vec3 uAmbientColor;
uniform vec3 uFallbackWarm;

// Three octaves, not the five the painted version used. The bake carries every
// feature bigger than a degree now, so this only has to supply what a 1024px
// cube face cannot — and three octaves of a warped flow at screen resolution is
// exactly that, at a third of what the old sky cost per fragment.
${flowLadder(3)}

void main() {
  vec3 dir = normalize(vDir);

  // The volume, as it was integrated. .rgb is radiance with the ordering
  // already resolved; .a is how much visible structure this direction has,
  // weighted by transmittance — so it is near zero both where there is nothing
  // and where everything is behind a wall of dust.
  vec4 baked = mix(textureCube(uPreview, dir), textureCube(uFull, dir), uFullMix);
  float w = baked.a;

  // The live layer. Multiplicative on purpose: an additive detail layer would
  // paint bright wisps over the dust lane and undo the one property the bake
  // exists to produce. Modulating preserves the ordering exactly — detail in a
  // shadowed region is detail on a dark number.
  float d = flow(dir * uDetail + uSeed, uWarp);
  vec3 col = baked.rgb * max(0.0, 1.0 + uDetailAmount * 1.7 * d * w);
  // ...and a small one-sided term on top, so the *densest* parts get sharp
  // bright threads rather than only sharp edges. Still scaled by the baked
  // radiance, so it cannot light up something the volume says is occluded.
  col += baked.rgb * (uDetailAmount * 0.55 * w) * max(d, 0.0);

  // Before the first bake lands — six frames, once — and permanently on a
  // renderer the bake refused to run on. Cheap by design: this is what
  // SwiftShader draws in the playtest harness.
  float lat = asin(clamp(dot(dir, uPole), -1.0, 1.0));
  float band = exp(-(lat * lat) / (uGasH * uGasH));
  vec3 fb = mix(uAmbientColor, uFallbackWarm, band) * (0.05 + band * 0.45)
          * max(0.35 + d, 0.0);

  col = mix(fb, col, uReady);

  // The floor. Real deep sky is not black either, and a hard zero makes the
  // band's edge a visible seam.
  col += uAmbient * uAmbientColor * (0.45 + 0.55 * w);

  gl_FragColor = vec4(col * uBrightness, 1.0);
}
`;

/**
 * The sky's haze. Owns one mesh and one bake; `Backdrop` owns the frame it hangs
 * in and `main.ts` parents it there.
 */
export class Nebula {
  readonly object = Object.assign(new Group(), { name: "nebula" });

  private readonly material: ShaderMaterial;
  private readonly mesh: Mesh;
  private readonly bake = new NebulaBake();
  private key = "";

  /**
   * The renderer, caught rather than passed.
   *
   * `main.ts` constructs this with no arguments and calls `sync()` with none
   * either, and that surface is not mine to change — but a bake needs the one
   * renderer `Stage` owns. `Object3D.onBeforeRender` hands it over on the first
   * frame this mesh is drawn, which is a documented three hook and the only
   * route that does not either invent a second GL context or reach for a
   * localhost-only global the playtest harness cannot see.
   */
  private renderer: WebGLRenderer | null = null;

  /** Set once, on a renderer the bake must not run on. See `checkRenderer`. */
  private disabled = false;
  /** The one-off timed job. See `BAKE.probeMs`. */
  private probed = false;
  private probeMs = 0;
  private jobsRun = 0;

  private ready = 0;
  private fullMix = 0;
  private hadPreview = false;
  private hadFull = false;

  private lastSync = 0;
  private signature = "";
  private stillFor = 0;
  private dirty = false;

  /** The last `show` arguments, so a knob change can replan without them. */
  private plan: NebulaBakePlan | null = null;

  /**
   * Whoever parented this group, remembered so `sync` can put it back.
   * See the class comment — `Backdrop.clear()` evicts it on every sector change.
   */
  private home: Object3D | null = null;

  /** The real `dispose` of the material and geometry, kept out of reach. */
  private readonly releaseGpu: () => void;

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uPreview: { value: this.bake.preview.texture },
        uFull: { value: this.bake.full.texture },
        uFullMix: { value: 0 },
        uReady: { value: 0 },
        uBrightness: { value: NEBULA.brightness },
        uDetail: { value: NEBULA.detail },
        uWarp: { value: NEBULA.warp },
        uDetailAmount: { value: NEBULA.detailAmount },
        uAmbient: { value: NEBULA.ambient },
        uSeed: { value: 0 },
        uPole: { value: new Vector3(0, 1, 0) },
        uGasH: { value: NEBULA.bandWidth },
        uAmbientColor: { value: new Color(0.16, 0.2, 0.36) },
        uFallbackWarm: { value: new Color(0.5, 0.28, 0.3) },
      },
      side: BackSide,
      // Additive over the cleared black, and never a depth writer: this is the
      // backmost thing in the scene by construction, so it has nothing to
      // occlude and nothing may be occluded by it.
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });

    // 64x32 is generous for a shape with no silhouette of its own — every
    // feature is in the fragment stage, so the tessellation only has to be fine
    // enough that `vDir`'s interpolation across a face is not visibly linear.
    this.mesh = new Mesh(new SphereGeometry(NEBULA.radius, 64, 32), this.material);
    this.mesh.frustumCulled = false;
    // Behind the starfield's own -2 (see `SKY`'s draw-order note in
    // `Backdrop.ts`), so stars paint over the haze rather than under it.
    this.mesh.renderOrder = -3;
    this.mesh.onBeforeRender = (renderer: WebGLRenderer): void => {
      if (this.renderer) return;
      this.renderer = renderer;
      this.checkRenderer(renderer);
    };
    this.object.add(this.mesh);

    /**
     * Take the eviction, refuse the free.
     *
     * `Backdrop.clear()` traverses each child it removes and disposes every
     * geometry and material it finds. Being removed is survivable — `sync`
     * re-adds — but being *disposed* is not free: a `ShaderMaterial` that has
     * had its program deallocated recompiles on the next draw, which is tens of
     * milliseconds landing on exactly the frame a hyperwarp arrives. Shadowing
     * `dispose` with a no-op and keeping the real one behind `releaseGpu` costs
     * one line of indirection and makes the sector change free. The alternative
     * — letting it recompile every sector and calling that acceptable — is the
     * kind of cost that never shows up in a profile because it is not in the
     * frame anyone thinks to measure.
     */
    /**
     * Learn the parent at the moment it is assigned, not the first time anyone
     * looks.
     *
     * The obvious version of this reads `this.object.parent` in `sync` and
     * caches it — and it never fires, because `main.ts`'s frame runs
     * `sky.show()` *before* `nebula.sync()`, so the very first eviction happens
     * before the first `sync` in the program's life. The parent is null every
     * time it is asked. Intercepting the assignment is the only hook that sees
     * the one moment the answer exists: `Object3D.add` sets `parent` directly,
     * so a property with a setter catches it on the way past and catches every
     * re-attach after.
     */
    let parent: Object3D | null = null;
    Object.defineProperty(this.object, "parent", {
      configurable: true,
      get: (): Object3D | null => parent,
      set: (value: Object3D | null): void => {
        parent = value;
        if (value) this.home = value;
      },
    });

    const releaseMaterial = this.material.dispose.bind(this.material);
    const releaseGeometry = this.mesh.geometry.dispose.bind(this.mesh.geometry);
    this.material.dispose = (): void => {};
    this.mesh.geometry.dispose = (): void => {};
    this.releaseGpu = (): void => {
      releaseMaterial();
      releaseGeometry();
    };

    /**
     * Unconditional, the way `__scenery` and `__tuning` are and for the same
     * reason: the playtest harness is a consumer and does not run on
     * `localhost`. This one matters more than most, because the nebula is the
     * one sky object `__scenery.hide()` cannot reach — it is parented under
     * `Backdrop`, not held in `main.ts`'s scenery list, and that file is not
     * mine to edit.
     */
    (window as unknown as Record<string, unknown>).__nebula = {
      constants: NEBULA,
      /**
       * `seed:sector` of what is currently built, or "" for nothing.
       *
       * The one fact that separates "the haze did not follow the sector" from
       * "`show` was never reached" — `aim()` alone cannot tell them apart, and
       * a harness guessing between them will eventually guess wrong.
       */
      key: (): string => this.key,
      state: (): Record<string, unknown> => ({
        disabled: this.disabled,
        progress: this.bake.progress,
        previewReady: this.bake.previewReady,
        fullReady: this.bake.fullReady,
        ready: this.ready,
        fullMix: this.fullMix,
        probeMs: this.probeMs,
      }),
      /** Force the whole queue to run again, one job a frame as usual. */
      rebake: (): void => {
        if (this.plan) this.bake.plan(this.plan, this.tuning());
      },
      /**
       * Where the interesting things are, in *world* space — the plan is in the
       * sky group's own frame and that group wheels, so a script that wants to
       * point a camera at the band or at the embedded star cannot work it out
       * from the seed alone.
       */
      aim: (): Record<string, number[]> | null => {
        if (!this.plan) return null;
        this.object.updateMatrixWorld();
        const basis = new Matrix3().setFromMatrix4(this.object.matrixWorld);
        const at = (v: Vector3): number[] =>
          v.clone().applyMatrix3(basis).normalize().toArray();
        return {
          pole: at(this.plan.pole),
          cloud: at(this.plan.cloud),
          star: at(this.plan.star),
          disc: at(this.plan.disc),
        };
      },
      /** The two cube targets, for a `readRenderTargetPixels` check on a face. */
      targets: { preview: this.bake.preview, full: this.bake.full },
      /**
       * Run the whole queue now, timing every job with a pipeline flush between
       * them, and leave the sky showing the finished cube.
       *
       * The flush is the entire point: without a synchronous read, ANGLE defers
       * the work and `performance.now()` measures command submission, which is
       * free and therefore a lie. It is also why this cannot be folded into the
       * ordinary per-frame path — a flush a frame would cost more than the bake.
       */
      measure: (): Record<string, number> | null => {
        const renderer = this.renderer;
        if (!renderer || !this.plan) return null;
        const gl = renderer.getContext();
        const pixel = new Uint8Array(4);
        const flush = (): void => {
          renderer.setRenderTarget(null);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        };
        this.bake.plan(this.plan, this.tuning());
        flush();
        const times: number[] = [];
        for (;;) {
          const started = performance.now();
          if (!this.bake.step(renderer)) break;
          flush();
          times.push(performance.now() - started);
        }
        this.hadPreview = true;
        this.hadFull = true;
        this.ready = 1;
        this.fullMix = 1;
        this.material.uniforms.uReady.value = 1;
        this.material.uniforms.uFullMix.value = 1;
        const sum = (from: number, to: number): number =>
          times.slice(from, to).reduce((a, b) => a + b, 0);
        return {
          jobs: times.length,
          totalMs: sum(0, times.length),
          previewMs: sum(0, 6),
          fullMs: sum(6, times.length),
          worstJobMs: Math.max(...times),
        };
      },
      /** Refuse the volume for the session; the sky falls back to the analytic band. */
      disable: (): void => {
        this.disabled = true;
        this.bake.abandon();
        this.hadPreview = false;
        this.hadFull = false;
      },
      hide: (): void => this.setVisible(false),
      show: (): void => this.setVisible(true),
    };
  }

  /**
   * Refuse to bake on a renderer that cannot afford it.
   *
   * SwiftShader is the case that has to be caught by name: `tools/playtest.mjs`
   * runs headless on software GL, `__scenery.hide()` cannot reach this object
   * (it lives under `Backdrop`, not in `main.ts`'s scenery list), and a
   * six-face volumetric raymarch on a software rasteriser is not slow, it is a
   * hang. The timed probe in `sync` (see `BAKE.probeMs`) catches everything
   * this list does not know the name of.
   */
  private checkRenderer(renderer: WebGLRenderer): void {
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const name = String(
        (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "",
      );
      if (/swiftshader|llvmpipe|software|mesa offscreen|basic render/i.test(name)) {
        this.disabled = true;
      }
    } catch {
      // A driver that will not answer is not itself a reason to refuse; the
      // timed probe covers the case where it should have been.
    }
  }

  /** The bake-affecting half of the console, gathered in one place. */
  private tuning(): NebulaBakeTuning {
    return {
      // Scaled down on the way in, and the factor is the whole difference
      // between a band and a wash: `bandWidth` reads as "the sine of the
      // latitude where the band thins out", and a slab whose half-thickness
      // *is* that number still shows a third of its plane brightness at the
      // pole. A bit under half of it, plus the finite disc and the local
      // bubble, lands the visible band at about ten degrees — which is where
      // `SKY.bandWidth` puts the star field it has to agree with.
      gasH: Math.max(0.02, NEBULA.bandWidth * 0.42),
      // Off the gas height rather than off `bandWidth`, so the lane stays a
      // fixed fraction *of the band it cuts* however wide that band is.
      dustH: Math.max(0.008, NEBULA.bandWidth * 0.42 * NEBULA.laneWidth),
      // Fifty-five, and the size of that number is the finding rather than an
      // embarrassment: a lane only reads as *matter* once its optical depth is
      // past two or three, and at the dust densities this medium actually
      // produces, a coefficient of three left the sky nine per cent darker
      // overall and nothing silhouetted at all — a slightly darker stripe, not
      // something in front of something else, which is the entire point of the
      // rebuild. Measured at 55: mean sky brightness falls by 54%, four fifths
      // of the frame darkens measurably, and the worst-occluded pixels lose
      // three quarters of their light. That is the A/B this knob exists for and
      // `NEBULA.depth` is how to run it again.
      kappa: 55 * NEBULA.laneDepth * NEBULA.depth,
      cavity: NEBULA.cavity,
      starPower: NEBULA.starPower,
      emission: NEBULA.emission,
      scatter: NEBULA.scatter,
      filament: NEBULA.filament,
      teal: NEBULA.teal,
      // Diffuse galactic ionisation — the reason the band glows at all far from
      // any one star. Not a knob: it is the difference between a nebula and a
      // spotlight, and there is no version of this picture where it is zero.
      //
      // Small, and that is a correction of the first draft rather than a
      // preference. At 0.35 the whole disc emitted H-alpha at a level that
      // buried everything else, and the sky came out as one flat pink — which
      // is also wrong about the real thing: the Milky Way's band is mostly
      // *starlight*, scattered and unresolved, not ionised hydrogen. So the
      // band belongs to the scattering channel and the crimson belongs near the
      // star that is doing the ionising. Getting that division right is most of
      // the difference between a photograph and a colour wash.
      diffuseIon: 0.035,
    };
  }

  /** Which knobs force a rebake, as one string. Cheap enough to build per frame. */
  private bakeSignature(): string {
    const n = NEBULA;
    return [
      n.bandWidth,
      n.laneDepth,
      n.laneWidth,
      n.depth,
      n.filament,
      n.emission,
      n.scatter,
      n.starPower,
      n.cavity,
      n.teal,
    ].join(",");
  }

  /**
   * Point the haze at a sector's own galactic plane and queue a bake.
   *
   * `pole` and `lane` come from `Backdrop`'s plan rather than from a roll of
   * this module's own, which is the whole reason the sky reads as one thing.
   * Everything else — where the cloud complex sits, where its star sits inside
   * it, the colours, and the rotation and offset that pick this sector's corner
   * out of the shared noise volume — is seeded here, so two sectors sharing a
   * plane still get different clouds.
   */
  show(seed: number, sector: number, pole: Vector3, lane: number): void {
    const key = `${seed}:${sector}`;
    if (key === this.key) return;
    this.key = key;

    const u = this.material.uniforms;
    (u.uPole.value as Vector3).copy(pole).normalize();
    u.uSeed.value = hash(seed, sector, 1) * 64;

    const p = new Vector3().copy(pole).normalize();
    // A basis in the galactic plane, built off whichever axis the pole is least
    // aligned with so the cross product never degenerates.
    const seedAxis =
      Math.abs(p.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
    const a = new Vector3().crossVectors(p, seedAxis).normalize();
    const b = new Vector3().crossVectors(p, a).normalize();

    /**
     * The cloud complex, and it is placed *in the band* rather than anywhere in
     * the sky. A star-forming region is a thing that happens in a galactic
     * disc, so putting it off the plane would be the one placement that reads
     * as wrong — and it also keeps the drama where the eye is already looking,
     * which is the same argument `Backdrop.ts` makes for holding the pole low.
     */
    const azimuth = hash(seed, sector, 6) * Math.PI * 2;
    const tilt = (hash(seed, sector, 7) - 0.5) * 0.55;
    // Far enough out that it reads as a *thing in the sky* rather than as
    // weather. The first draft put it at a fifth of the march length with a
    // radius nearly as large, so it subtended about sixty degrees and filled
    // half the frame with a soft glow — at that size a cavity is not a hole in
    // a cloud, it is the background. Roughly twenty degrees across is where it
    // becomes an object with an inside.
    const distance = 0.3 + hash(seed, sector, 8) * 0.25;
    const cloud = new Vector3()
      .addScaledVector(a, Math.cos(azimuth))
      .addScaledVector(b, Math.sin(azimuth))
      .addScaledVector(p, Math.tan(tilt))
      .normalize()
      .multiplyScalar(distance);
    const cloudR = 0.09 + hash(seed, sector, 9) * 0.09;

    // The disc's own centre, in the plane and well off the observer, so this
    // sector has an inner galaxy on one side and a thin anticentre on the
    // other. Its own azimuth, unrelated to the cloud's, because the one place
    // you should not always find the star-forming region is dead centre of the
    // brightest part of the band.
    const discAz = hash(seed, sector, 24) * Math.PI * 2;
    const disc = new Vector3()
      .addScaledVector(a, Math.cos(discAz))
      .addScaledVector(b, Math.sin(discAz))
      .multiplyScalar(0.45 + hash(seed, sector, 25) * 0.25);
    const discR = 0.62 + hash(seed, sector, 26) * 0.28;

    // The star sits off-centre inside its own cloud. Dead centre would give a
    // symmetric cavity, and a symmetric cavity reads as a bubble rather than as
    // a hole something blew in one side.
    const so = hash(seed, sector, 10) * Math.PI * 2;
    const sp = (hash(seed, sector, 11) - 0.5) * Math.PI;
    const sr = cloudR * (0.12 + hash(seed, sector, 12) * 0.26);
    const star = new Vector3(
      Math.cos(sp) * Math.cos(so),
      Math.sin(sp),
      Math.cos(sp) * Math.sin(so),
    )
      .multiplyScalar(sr)
      .add(cloud);

    /**
     * Colour, and this is where the sky's old ceiling is deliberately left
     * behind — but the licence is spent differently than it was.
     *
     * `SKY_COLOUR.maxSaturation` caps a body at 0.22 so nothing up there can be
     * read as a contact, and that rule is sound for a *disc*. A haze cannot be
     * mistaken for a blip: it has no edge, no centre, and it covers a third of
     * the sky at once. The old version spent that licence on a free choice of
     * two hues. This one spends it on *physics*: H-alpha really is crimson and
     * O III really is teal, dust really scatters blue, and holding near those
     * values is most of why the result reads as a photograph rather than as a
     * colour scheme. What varies per sector is the small stuff — where in the
     * red the H-alpha sits, how green the O III is, how blue the dust is, and
     * how hot the star is — which is variety without leaving the physics.
     */
    // Crimson, but not *pure* 656 nm crimson. A single-wavelength red renders
    // as a red filter over the sky — no chroma anywhere but the one axis — and
    // real H-alpha regions photograph pink because [N II] sits either side of
    // it and H-beta is in there too. Pulling the saturation back to the low
    // seventies and the lightness above the middle is the cheapest honest way
    // to say that, and it is the difference between a nebula and a warning
    // light.
    const ha = new Color().setHSL(
      0.975 + hash(seed, sector, 13) * 0.035,
      0.62 + hash(seed, sector, 14) * 0.16,
      0.58,
      SRGBColorSpace,
    );
    const oiii = new Color().setHSL(
      0.44 + hash(seed, sector, 15) * 0.07,
      0.62 + hash(seed, sector, 16) * 0.24,
      0.52,
      SRGBColorSpace,
    );
    const albedo = new Color().setHSL(
      0.575 + hash(seed, sector, 17) * 0.055,
      0.45 + hash(seed, sector, 18) * 0.3,
      0.62,
      SRGBColorSpace,
    );
    // The diffuse interstellar radiation field — the whole galaxy's own starlight,
    // which is what lights dust nowhere near any one star.
    const isrf = new Color().setHSL(0.6, 0.42, 0.42, SRGBColorSpace);
    // Mostly an O or B star — blue-white, which is what actually ionises a
    // cloud. One sector in five gets a cooler one, so the reflection half of
    // the picture is not always the same temperature.
    const hot = hash(seed, sector, 19);
    const starColor = new Color().setHSL(
      hot < 0.2 ? 0.08 + hot * 0.15 : 0.57 + hot * 0.06,
      0.3 + hash(seed, sector, 20) * 0.25,
      0.72,
      SRGBColorSpace,
    );

    // A seeded rotation and offset of the sampling coordinates is the whole
    // per-sector variation of the noise volume — see `volumeNoise.ts` for why
    // the field itself is fixed and shared.
    const rot = new Matrix3().setFromMatrix4(
      new Matrix4().makeRotationFromEuler(
        new Euler(
          hash(seed, sector, 2) * Math.PI * 2,
          hash(seed, sector, 3) * Math.PI * 2,
          hash(seed, sector, 4) * Math.PI * 2,
        ),
      ),
    );

    this.plan = {
      pole: p,
      // Already radians: `Backdrop.plane` converts on the way out, because
      // every consumer of it is a shader.
      laneRad: lane,
      cloud,
      star,
      disc,
      discR,
      cloudR,
      starColor,
      ha,
      oiii,
      albedo,
      isrf,
      noiseOffset: new Vector3(
        hash(seed, sector, 21) * 8,
        hash(seed, sector, 22) * 8,
        hash(seed, sector, 23) * 8,
      ),
      noiseRot: rot,
    };

    this.signature = this.bakeSignature();
    this.dirty = false;
    if (!this.disabled) this.bake.plan(this.plan, this.tuning());
  }

  /**
   * Push the live constants at the material, and advance the bake by one job.
   * Called every frame from `main.ts`; see `tuning.ts`.
   */
  /**
   * Draw, or do not.
   *
   * A real method rather than only a closure on `__nebula`, because the
   * harness's own switch is `__scenery.hide()` and that has to reach every
   * scenery object through one call. The bake is deliberately *not* stopped
   * here — it is one job a frame, it is already refused outright on a renderer
   * that cannot afford it (see the guard below), and a hidden sky that quietly
   * finished baking is a sky that is correct the instant it is shown again.
   * Stopping the bake is `__nebula.disable()`, which is a different question.
   */
  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  sync(): void {
    const now = performance.now();
    // Its own clock rather than a `dt` argument, because the call site's
    // signature is not mine to change. Clamped for the same reason every other
    // accumulator here is: a tab that was in the background must not fast-
    // forward a crossfade to its end.
    const dt = this.lastSync === 0 ? 1 / 60 : Math.min((now - this.lastSync) / 1000, 0.1);
    this.lastSync = now;

    // Re-attach, if the backdrop has just rebuilt itself and taken this group
    // with it. `main.ts` calls this immediately after `sky.show()`, so the
    // eviction never survives to a rendered frame. See the class comment.
    if (this.object.parent) this.home = this.object.parent;
    else if (this.home) this.home.add(this.object);

    const u = this.material.uniforms;
    u.uBrightness.value = NEBULA.brightness;
    u.uDetail.value = NEBULA.detail;
    u.uWarp.value = NEBULA.warp;
    u.uDetailAmount.value = NEBULA.detailAmount;
    u.uAmbient.value = NEBULA.ambient;
    u.uGasH.value = NEBULA.bandWidth;

    if (!this.disabled && this.renderer) {
      // The braces to `checkRenderer`'s belt. A frame that ran a bake job and
      // then took longer than the budget is a renderer this must not be running
      // on, whatever it calls itself. Two strikes rather than one, because the
      // first bake frame can land on the same frame as a shader compile.
      // A held repeat on the tuning console would otherwise restart the queue
      // every frame and never finish one. The knob has to sit still first.
      const signature = this.bakeSignature();
      if (signature !== this.signature) {
        this.signature = signature;
        this.dirty = true;
        this.stillFor = 0;
      } else if (this.dirty) {
        this.stillFor += dt;
        if (this.stillFor >= REBAKE_DELAY) {
          this.dirty = false;
          if (this.plan) this.bake.plan(this.plan, this.tuning());
        }
      }

      // Time the *second* job, once, with a pipeline flush — see `BAKE.probeMs`
      // for why it is a measurement rather than an inference from frame times,
      // and why the first job is the wrong one to time.
      const probing = !this.probed && this.jobsRun === 1;
      const gl = probing ? this.renderer.getContext() : null;
      const drain = (): void => {
        this.renderer?.setRenderTarget(null);
        gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      };
      // Drain *before* the clock starts as well as after. A `readPixels` waits
      // for everything already queued, so timing one that follows a whole
      // unflushed frame measures the frame, not the job — which read as 16 ms
      // on a machine where the job is 0.6.
      // ...and a second empty drain, timed, to price the round trip itself.
      // `readPixels` to the CPU costs a few milliseconds in some browsers
      // whatever the GPU did, and charging that to the bake would leave the
      // threshold measuring the browser rather than the renderer.
      let overhead = 0;
      if (probing) {
        drain();
        const zero = performance.now();
        drain();
        overhead = performance.now() - zero;
      }
      const started = probing ? performance.now() : 0;
      if (this.bake.step(this.renderer)) this.jobsRun++;
      if (probing) {
        drain();
        this.probeMs = Math.max(0, performance.now() - started - overhead);
        this.probed = true;
        if (this.probeMs > BAKE.probeMs) {
          this.disabled = true;
          this.bake.abandon();
        }
      }
    }

    if (this.bake.previewReady) this.hadPreview = true;
    if (this.bake.fullReady) this.hadFull = true;

    /**
     * The crossfade, and its one non-obvious rule: while the *preview* faces are
     * being rewritten, keep showing the old **full** cube.
     *
     * The preview target is the thing under the pen for those six frames, and
     * sampling a half-rewritten cube shows the sky changing a quadrant at a
     * time. The full cube is untouched until job six, so holding on it costs
     * nothing and means a sector change never falls back to the flat analytic
     * band once a bake has ever landed. Order: old sharp, new coarse, new sharp.
     */
    const holdFull = !this.bake.previewReady && this.hadFull;
    const fullTarget = this.bake.fullReady || holdFull ? 1 : 0;
    // Down quicker than up: dropping to the preview is a softening nobody
    // should study, and arriving at the full cube is a sharpening worth easing.
    this.fullMix = approach(this.fullMix, fullTarget, fullTarget > this.fullMix ? 0.45 : 0.12, dt);

    const readyTarget = this.disabled ? 0 : this.bake.previewReady || this.hadPreview ? 1 : 0;
    this.ready = approach(this.ready, readyTarget, readyTarget > this.ready ? 0.3 : 0.12, dt);

    u.uFullMix.value = this.fullMix;
    u.uReady.value = this.ready;
  }

  dispose(): void {
    // Through the stashed originals, because the public `dispose` on both is a
    // no-op that exists to survive `Backdrop.clear()`. See the constructor.
    this.releaseGpu();
    this.bake.dispose();
  }
}
