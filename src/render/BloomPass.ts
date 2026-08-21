import {
  AddEquation,
  ClampToEdgeWrapping,
  CustomBlending,
  HalfFloatType,
  LinearFilter,
  NoBlending,
  OneFactor,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * Multi-scale glare, in place of `UnrealBloomPass`.
 *
 * The art direction is thin bright lines on black, and that is the one case
 * `UnrealBloomPass` is worst at. Two of its properties fight it:
 *
 * **It thresholds hard.** At `0.5` a full-brightness `PALETTE.trace` stroke
 * (luma 0.65 linear) blooms and `PALETTE.traceDim` (0.22) does not — so the
 * grid, the starfield and distant structure had no glow at all, and anything
 * crossing the threshold as it approached popped into one. A real tube has no
 * threshold: the glass scatters in proportion to beam energy, all the way down.
 * The soft knee below replaces the cliff with a curve that is never zero —
 * roughly 19% of a dim stroke's energy scatters, roughly 90% of a torpedo
 * detonation's — so everything glows a little and only hot things glow a lot.
 *
 * **It blurs at five fixed scales with separable Gaussians**, ten full passes
 * of 7–23 taps, and composites them with hand-picked weights that are not
 * energy-conserving. The result is a single-width smear: past its widest mip
 * there is nothing, and inside it the falloff is flat enough to read as a wash
 * laid over the ship rather than as light coming off it.
 *
 * What replaces it is the progressive down/up-sample pyramid from Jimenez,
 * *Next Generation Post Processing in Call of Duty: Advanced Warfare*
 * (SIGGRAPH 2014): halve the buffer repeatedly with a 13-tap filter, then walk
 * back up adding each level into the one below it through a 9-tap tent. Every
 * octave of scale contributes, so the profile is a tight core sitting in a
 * halo that keeps going soft and faint out to a good fraction of the frame —
 * which is what a vector monitor's glass actually does, and what a long
 * exposure of neon looks like. It is also *cheaper*: ~24M texel fetches a
 * frame at 3024x1964 against `UnrealBloomPass`'s ~48M, because the pyramid
 * does its widest blurring at 23x15 rather than by widening a kernel at half
 * resolution. Measured on an M2 Max at 3024x1964, against the same frame with
 * the bloom pass disabled entirely (3.16 ms): `UnrealBloomPass` costs
 * **0.86 ms**, this costs **0.58 ms**. A wider, softer, thresholdless glare
 * for two thirds of what the narrow one cost.
 *
 * **No Karis average on the first downsample.** The standard implementation
 * weights the first tap set by `1/(1+luma)` to stop a single hot pixel
 * flickering the whole halo. That is a fix for specular fireflies on surfaces,
 * and here it would be aimed squarely at the wrong target: an isolated hot
 * pixel in this game is a torpedo detonation or a phaser landing — the thing
 * the bloom exists for. Suppressing its energy would defeat the pass. The
 * temporal stability it buys is bought instead by the 4x MSAA on the scene
 * target (see `Stage`) and by the phosphor trail, which already integrates
 * across frames.
 *
 * Composites additively into the read buffer and does not swap, the same
 * arrangement `UnrealBloomPass` used: one full-resolution write with no
 * matching read, rather than a full copy.
 */
export class BloomPass extends Pass {
  /**
   * Overall gain on the composited glare. Named to match what it replaced
   * because `main.ts` binds `[`/`]` straight to it.
   */
  strength = 0.72;

  /**
   * Tent radius for the upsample, in texels of the level being read.
   *
   * Note this is *not* `UnrealBloomPass.radius`, which lerped between fixed
   * mip weights on 0..1. Here the pyramid decides the scales and this decides
   * how much each level smears as it is carried down into the next — 1.0 is
   * the textbook tent, above that trades a little banding for a softer halo.
   */
  radius = 1.15;

  /**
   * Where the knee is centred and how wide it is, in linear luma.
   *
   * Deliberately far below `UnrealBloomPass`'s old 0.5 and paired with a knee
   * nearly as wide as the threshold itself, which is what turns a cutoff into
   * a ramp. Setting `threshold` to 0 makes the pass thresholdless — every
   * lit pixel contributes its full energy — which is the physically honest
   * setting and reads as haze, because 7% of this game's pixels are lit and
   * the glow then has nothing dark to sit against.
   */
  threshold = 0.3;
  knee = 0.35;

  /**
   * Per-octave gain applied as each level is added into the finer one below.
   *
   * A thin line loses about half its value per downsample (it covers one row
   * of two), so at 1.0 the halo falls off like 1/r² and every step above that
   * flattens the tail: at 1.25 the octaves decay by 0.625 each and the halo
   * integrates to roughly twice the core.
   *
   * **This was written at 1.25 by that reasoning and then measured, and the
   * reasoning was wrong about the frame it lands on.** On a real in-run scene
   * (asteroid field, hero sun) at 3024x1964, counting the max channel of every
   * pixel against the chain this replaced:
   *
   *     UnrealBloomPass    mean 44.9/255,  33.5% of pixels in the bottom octave
   *     pyramid, gain 0.90 mean 46.4       34.9%
   *     pyramid, gain 1.00 mean 50.8       26.1%
   *     pyramid, gain 1.10 mean 56.2       19.3%
   *     pyramid, gain 1.25 mean 66.5       12.6%
   *
   * The widest octaves cover the whole frame, so flattening their falloff does
   * not add halo around bright things — it adds a floor everywhere. At 1.25 it
   * lifted two thirds of the void out of the bottom sRGB octave and the frame
   * read as fogged: the asteroids lost their orange, the starfield lost its
   * black, and the game stopped being thin bright lines on anything.
   *
   * 0.90 is the measured point where the *total* light in the frame matches
   * what `UnrealBloomPass` put there, which makes this an honest
   * redistribution rather than an exposure change — the same energy, taken out
   * of the clipped cores and spread into a halo that actually has a tail. Every
   * octave still contributes and the glow is still far wider than what it
   * replaced; what it is not is uniform. Raise this and the first thing to go
   * is the void, which is the one thing the art direction cannot spend.
   */
  octaveGain = 0.9;

  /** Half resolution down to this, at which point another level buys nothing. */
  private static readonly MIN_EDGE = 8;
  private static readonly MAX_LEVELS = 8;

  private mips: WebGLRenderTarget[] = [];

  private readonly prefilter: ShaderMaterial;
  private readonly down: ShaderMaterial;
  private readonly up: ShaderMaterial;
  private readonly composite: ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor() {
    super();

    this.prefilter = new ShaderMaterial({
      name: "BloomPass.prefilter",
      uniforms: {
        tSource: { value: null },
        uTexel: { value: new Vector2() },
        uThreshold: { value: this.threshold },
        uKnee: { value: this.knee },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
        ${TAPS}
        uniform sampler2D tSource;
        uniform vec2 uTexel;
        uniform float uThreshold;
        uniform float uKnee;
        varying vec2 vUv;

        void main() {
          // Downsampled and knee'd in one pass: the prefilter is the first
          // halving, so doing it with a single tap would alias the very thin
          // lines this whole pass exists to spread.
          vec3 c = downsample13(tSource, vUv, uTexel);

          // Quadratic soft knee. Below the threshold the curve is a parabola
          // through the origin rather than a floor of zero, so a dim stroke
          // still scatters — just weakly — and nothing pops as it brightens.
          float bright = max(c.r, max(c.g, c.b));
          float soft = clamp(bright - uThreshold + uKnee, 0.0, 2.0 * uKnee);
          soft = soft * soft / (4.0 * uKnee + 1e-4);
          float contribution = max(soft, bright - uThreshold) / max(bright, 1e-4);

          // Scaled, never clipped: the scene target is half-float and reaches
          // ~5.6 in a firefight. Clamping here is what would put the flat
          // white patches back.
          gl_FragColor = vec4(c * contribution, 1.0);
        }
      `,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.down = new ShaderMaterial({
      name: "BloomPass.down",
      uniforms: {
        tSource: { value: null },
        uTexel: { value: new Vector2() },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
        ${TAPS}
        uniform sampler2D tSource;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(downsample13(tSource, vUv, uTexel), 1.0);
        }
      `,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.up = new ShaderMaterial({
      name: "BloomPass.up",
      uniforms: {
        tSource: { value: null },
        uTexel: { value: new Vector2() },
        uRadius: { value: this.radius },
        uScale: { value: this.octaveGain },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
        ${TAPS}
        uniform sampler2D tSource;
        uniform vec2 uTexel;
        uniform float uRadius;
        uniform float uScale;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(tent9(tSource, vUv, uTexel * uRadius) * uScale, 1.0);
        }
      `,
      // Straight `One, One`, not `AdditiveBlending`: three's additive preset
      // is `SRC_ALPHA, ONE`, which would make the alpha channel a hidden
      // second gain on a pass that has no use for alpha at all.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.composite = new ShaderMaterial({
      name: "BloomPass.composite",
      uniforms: {
        tBloom: { value: null },
        uStrength: { value: this.strength },
      },
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tBloom;
        uniform float uStrength;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(texture2D(tBloom, vUv).rgb * uStrength, 1.0);
        }
      `,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.quad = new FullScreenQuad(this.prefilter);

    // Adds into the buffer it was handed; there is nothing for the composer to
    // swap to.
    this.needsSwap = false;
  }

  override setSize(width: number, height: number): void {
    // Levels are chosen from the buffer rather than fixed, so the halo covers
    // the same *fraction* of the frame at every resolution. A fixed count
    // would make the glare wider on a small window than on a large one.
    const sizes: Vector2[] = [];
    let w = Math.max(1, Math.floor(width / 2));
    let h = Math.max(1, Math.floor(height / 2));
    while (
      sizes.length < BloomPass.MAX_LEVELS &&
      Math.min(w, h) >= BloomPass.MIN_EDGE
    ) {
      sizes.push(new Vector2(w, h));
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
    if (sizes.length === 0) sizes.push(new Vector2(Math.max(1, w), Math.max(1, h)));

    if (this.mips.length !== sizes.length) {
      for (const mip of this.mips) mip.dispose();
      this.mips = sizes.map((size, i) => {
        const target = new WebGLRenderTarget(size.x, size.y, {
          type: HalfFloatType,
          minFilter: LinearFilter,
          magFilter: LinearFilter,
          // Every tap of both filters reaches outside the quad at the border.
          // Wrapping there would fold the opposite edge of the screen into the
          // halo — a bright stroke at the left bleeding in from the right.
          wrapS: ClampToEdgeWrapping,
          wrapT: ClampToEdgeWrapping,
          depthBuffer: false,
          stencilBuffer: false,
        });
        target.texture.name = `BloomPass.mip${i}`;
        return target;
      });
    } else {
      this.mips.forEach((mip, i) => mip.setSize(sizes[i].x, sizes[i].y));
    }
  }

  override render(
    renderer: WebGLRenderer,
    // Named out rather than used: `needsSwap` is false, so the composer never
    // hands this pass a destination — the glare is added back over the buffer
    // it was given, exactly as `UnrealBloomPass` did.
    _writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    if (this.mips.length === 0) return;

    this.prefilter.uniforms.uThreshold.value = this.threshold;
    this.prefilter.uniforms.uKnee.value = this.knee;
    this.up.uniforms.uRadius.value = this.radius;
    this.up.uniforms.uScale.value = this.octaveGain;
    this.composite.uniforms.uStrength.value = this.strength;

    // Down: the scene into mip 0, then each level into the next. The texel
    // size is always the *source's*, because that is what the 13 taps are
    // spaced in.
    this.quad.material = this.prefilter;
    this.prefilter.uniforms.tSource.value = readBuffer.texture;
    this.prefilter.uniforms.uTexel.value.set(
      1 / Math.max(1, readBuffer.width),
      1 / Math.max(1, readBuffer.height),
    );
    renderer.setRenderTarget(this.mips[0]);
    this.quad.render(renderer);

    this.quad.material = this.down;
    for (let i = 1; i < this.mips.length; i++) {
      const source = this.mips[i - 1];
      this.down.uniforms.tSource.value = source.texture;
      this.down.uniforms.uTexel.value.set(1 / source.width, 1 / source.height);
      renderer.setRenderTarget(this.mips[i]);
      this.quad.render(renderer);
    }

    // Up: each level tent-filtered and *added* into the finer one, so by the
    // time this reaches mip 0 it holds every octave at once. Nothing is
    // cleared on the way — the downsample chain above just overwrote all of
    // it, and the sum is the whole point.
    this.quad.material = this.up;
    for (let i = this.mips.length - 1; i > 0; i--) {
      const source = this.mips[i];
      this.up.uniforms.tSource.value = source.texture;
      this.up.uniforms.uTexel.value.set(1 / source.width, 1 / source.height);
      renderer.setRenderTarget(this.mips[i - 1]);
      this.quad.render(renderer);
    }

    // ...and mip 0 back over the scene. It is half resolution and every pixel
    // of it has been through at least one 13-tap filter, so the bilinear
    // stretch costs nothing anyone can see.
    this.quad.material = this.composite;
    this.composite.uniforms.tBloom.value = this.mips[0].texture;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    for (const mip of this.mips) mip.dispose();
    this.mips = [];
    this.prefilter.dispose();
    this.down.dispose();
    this.up.dispose();
    this.composite.dispose();
    this.quad.dispose();
  }
}

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The two filters, shared verbatim by three of the four materials.
 *
 * `downsample13` is the 13-tap from the Jimenez talk: a 3x3 grid at ±2 source
 * texels plus a 2x2 at ±1, weighted 1/32 : 1/16 : 1/8 : 1/8 so the whole thing
 * sums to exactly 1. The overlapping inner quad is what stops the pyramid
 * pulsing as the camera moves — a plain box filter drops a thin line entirely
 * on the frames where it lands between texel centres, and every stroke in this
 * game is a thin line.
 *
 * `tent9` is the matching upsample: a 3x3 Bartlett kernel, 4:2:1, also summing
 * to 1. Bilinear on its own would leave visible mip-shaped squares in the halo
 * at the wide end; the tent is the cheapest thing that does not.
 */
const TAPS = /* glsl */ `
  vec3 downsample13(sampler2D tex, vec2 uv, vec2 texel) {
    vec3 a = texture2D(tex, uv + texel * vec2(-2.0,  2.0)).rgb;
    vec3 b = texture2D(tex, uv + texel * vec2( 0.0,  2.0)).rgb;
    vec3 c = texture2D(tex, uv + texel * vec2( 2.0,  2.0)).rgb;
    vec3 d = texture2D(tex, uv + texel * vec2(-2.0,  0.0)).rgb;
    vec3 e = texture2D(tex, uv).rgb;
    vec3 f = texture2D(tex, uv + texel * vec2( 2.0,  0.0)).rgb;
    vec3 g = texture2D(tex, uv + texel * vec2(-2.0, -2.0)).rgb;
    vec3 h = texture2D(tex, uv + texel * vec2( 0.0, -2.0)).rgb;
    vec3 i = texture2D(tex, uv + texel * vec2( 2.0, -2.0)).rgb;
    vec3 j = texture2D(tex, uv + texel * vec2(-1.0,  1.0)).rgb;
    vec3 k = texture2D(tex, uv + texel * vec2( 1.0,  1.0)).rgb;
    vec3 l = texture2D(tex, uv + texel * vec2(-1.0, -1.0)).rgb;
    vec3 m = texture2D(tex, uv + texel * vec2( 1.0, -1.0)).rgb;
    return e * 0.125
         + (a + c + g + i) * 0.03125
         + (b + d + f + h) * 0.0625
         + (j + k + l + m) * 0.125;
  }

  vec3 tent9(sampler2D tex, vec2 uv, vec2 texel) {
    vec3 sum = texture2D(tex, uv + texel * vec2(-1.0,  1.0)).rgb;
    sum += texture2D(tex, uv + texel * vec2( 0.0,  1.0)).rgb * 2.0;
    sum += texture2D(tex, uv + texel * vec2( 1.0,  1.0)).rgb;
    sum += texture2D(tex, uv + texel * vec2(-1.0,  0.0)).rgb * 2.0;
    sum += texture2D(tex, uv).rgb * 4.0;
    sum += texture2D(tex, uv + texel * vec2( 1.0,  0.0)).rgb * 2.0;
    sum += texture2D(tex, uv + texel * vec2(-1.0, -1.0)).rgb;
    sum += texture2D(tex, uv + texel * vec2( 0.0, -1.0)).rgb * 2.0;
    sum += texture2D(tex, uv + texel * vec2( 1.0, -1.0)).rgb;
    return sum * 0.0625;
  }
`;
