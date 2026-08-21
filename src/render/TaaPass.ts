import {
  HalfFloatType,
  LinearFilter,
  Matrix4,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from "three";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * Temporal antialiasing: the scene camera is nudged by a fraction of a pixel
 * every frame and the frames are averaged back together, so a stroke that a
 * single frame can only place on one side of a pixel boundary lands on both
 * sides across a handful of frames and the edge resolves into the gradient it
 * always was.
 *
 * ## Why this, on top of MSAA that is already on
 *
 * `Stage`'s scene target already runs 4x MSAA, and it is worth being precise
 * about what that does and does not fix. MSAA quantises coverage to four
 * levels. A one-pixel-wide bright line on black — which is the entire art
 * direction — moving slowly across the screen therefore steps through five
 * discrete brightnesses per pixel rather than sliding smoothly, and the step
 * *pattern* marches along the line as it rotates. That is crawl, and it is the
 * artefact that survives 4x and would still survive 8x; you cannot fix a
 * quantisation problem by making the frame prettier, only by having more
 * samples, and the cheapest place to get more samples is the frames you are
 * already drawing. Sixteen frames of jitter is 16x coverage at the cost of one
 * extra full-screen pass, and at 60fps with hit-stop as the only thing allowed
 * to scale time (`CLAUDE.md`), the frames arrive on a clock we control.
 *
 * MSAA stays on. The two are complementary rather than alternatives: MSAA
 * gives each individual frame a defensible starting point (so the history
 * being clamped against a *jaggy* neighbourhood does not reintroduce the very
 * steps we are averaging out), and the jitter integrates what is left. Turning
 * MSAA off to "pay" for this was measured as the wrong trade — see the report
 * in `Stage`'s own header for the resolve-count argument that put it there.
 *
 * ## Where it sits, and why it is *before* the phosphor
 *
 * This is the one genuinely load-bearing decision in the file, because
 * `PhosphorPass` is already a temporal feedback buffer and stacking two of
 * them in the wrong order produces something that looks like a bug in both.
 *
 * TAA runs **first in the chain, on the raw scene target, before bloom and
 * long before the phosphor.** Three separate reasons, any one of which would
 * be sufficient:
 *
 * **1. The jitter must not reach the phosphor.** The phosphor's feedback is
 * `max(current, decayed history)` — a union, not an average. Feed it the
 * *unresolved* jittered frames and it takes the union of every jitter position
 * a stroke has occupied, which fattens every line in the game by a pixel and
 * holds it there. That is not merely "TAA does nothing"; it is worse than no
 * TAA at all, because the jitter would then be actively widening the thin
 * bright lines the whole look is made of. Resolving first means the phosphor
 * only ever sees a stable, converged image and behaves exactly as it did
 * before this pass existed.
 *
 * **2. A feedback buffer cannot be neighbourhood-clamped against another
 * feedback buffer.** TAA's entire defence against ghosting is comparing the
 * history against the 3x3 neighbourhood of the *current* frame and rejecting
 * history that falls outside it. After the phosphor, the "current" frame is
 * itself a trail — every neighbourhood already contains several frames of
 * smeared history, so the clamping box is enormous everywhere something is
 * moving, which is precisely where the clamp is meant to bite. The clamp would
 * pass anything, and the two feedback loops would compound: a trail that is
 * fed back into a buffer that is fed back into a trail decays as the *product*
 * of the two survival rates, which is a much longer, greasier smear than
 * `phosphor.decay` claims to produce. The one knob a person tunes would stop
 * describing what they see.
 *
 * **3. Depth only exists here.** Reprojection needs the depth buffer, and the
 * depth buffer belongs to the scene target. After bloom there is no depth that
 * corresponds to what is on screen; bloom has already spread a hot pixel over
 * a fifth of the frame and there is no single surface behind that pixel any
 * more.
 *
 * The order that follows is `scene → TAA → god rays → bloom → phosphor → CRT →
 * tone map`, and the existing argument for the rest of it is untouched: bloom
 * still sits before the feedback buffer so the trail inherits the glow, and
 * the CRT and the tone map still sit last so scanlines and rolloff act on real
 * light. TAA simply does its work before any of them have had a chance to
 * destroy the correspondence between a pixel and a surface.
 *
 * The alternative that was considered and rejected: resolving *after* the
 * phosphor so that a single TAA pass antialiases the trail as well as the
 * strokes. Trails are already several frames wide and blurred by the
 * phosphor's own texel bleed; there is nothing left in them to alias. It would
 * have bought nothing and cost every problem in the two paragraphs above.
 *
 * ## Ghosting, which is the other hazard
 *
 * An additively-blended stroke moving fast over black is the textbook worst
 * case for TAA, and this game is mostly that. There is no velocity buffer —
 * reprojection is camera-only, from depth — so a hostile crossing the frame
 * has *wrong* motion vectors, not merely imprecise ones. Three things carry
 * it:
 *
 * - **The neighbourhood clamp does its best work on this exact image.** A
 *   stroke that has moved on leaves a pixel whose 3x3 neighbourhood is now
 *   void — near-black, with a tiny box — so the stale bright history is
 *   clamped down to that box in one frame. Ghosting survives clamping when the
 *   background is busy and the box is wide; on black it collapses. The art
 *   direction that makes TAA worth doing is the same one that makes it safe.
 * - **Variance clipping, not just min/max** (Salvi's mean ± γσ, intersected
 *   with the box). A pure min/max box over a neighbourhood that contains one
 *   bright stroke pixel is as wide as that stroke is bright, which lets a ghost
 *   through along every edge. The standard deviation of a neighbourhood that is
 *   eight parts void and one part beam is small, so the clip tightens exactly
 *   where the box is loosest.
 * - **Luminance weighting on the blend** (Karis). Averaging HDR values
 *   directly lets one 5x-white pixel dominate sixteen frames of history and
 *   flicker; weighting each side by `1/(1+luma)` before the mix and dividing
 *   the weights back out makes the average behave like it was taken in display
 *   space without actually tone mapping anything, which matters because the
 *   whole chain downstream is committed to real linear light.
 *
 * And one blunt instrument for the case none of that covers: the history is
 * dropped outright when the camera *jumps* — a hyperwarp arrival, a camera
 * mode switch, a restart. Those move the camera further in one frame than any
 * reprojection can follow, and a single frame of aliasing is invisible next to
 * a frame of the previous sector smeared across the new one.
 */
export class TaaPass extends Pass {
  /**
   * Fraction of the resolved pixel taken from history each frame.
   *
   * 0.9 is ten frames of effective integration — a sixth of a second, which is
   * enough to resolve a crawling edge and short enough that a clamp failure
   * clears before the eye finds it. Lower is crisper and crawlier; above ~0.95
   * the convergence outruns the clamp's ability to evict a wrong sample and
   * fast strokes start to smear.
   */
  feedback = 0.9;

  /**
   * Width of the variance clip, in standard deviations of the 3x3
   * neighbourhood. Smaller rejects more history — less ghosting, more crawl.
   * 1.0 is the usual starting point; this game's neighbourhoods are unusually
   * low-variance (void), so the clip is the tighter of the two bounds almost
   * everywhere and this number does most of the work `clampScale` would do
   * elsewhere.
   */
  clampGamma = 1.25;

  /**
   * Jitter amplitude in pixels, peak to peak. 1.0 is exactly one pixel, which
   * is the correct value for reconstructing a box filter and the only value
   * with a defensible derivation. Below 1 the samples do not cover the pixel
   * and edges stay slightly stepped; above 1 the pass samples outside the
   * pixel it is reconstructing, which is a blur, not an antialias. Exposed
   * because "slightly soft" is a legitimate thing to want from a tube and
   * because the number to try when something looks wrong is this one.
   */
  jitterScale = 1;

  /**
   * World units the camera may move in one frame before the history is thrown
   * away. Sized well above ordinary flight (a fast ship covers a few units a
   * frame) and well below a hyperwarp arrival or a camera-mode switch, both of
   * which teleport.
   */
  jumpDistance = 40;

  /** Length of the Halton spiral before it repeats. */
  private static readonly PERIOD = 16;

  private readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;
  /**
   * `front` is the buffer this frame resolves *into*; `back` holds the
   * previous frame's result and is what the shader reads as history. They are
   * swapped in `endFrame`, before the composer runs, rather than after the
   * resolve — which matters for one reason and it is not cosmetic: `Stage`
   * points the chain's source at `output` before calling the composer, so
   * `output` has to name the buffer that is *about to* be written. Swapping
   * after the resolve instead put a whole frame of latency into the picture,
   * invisibly, because on a still scene the two buffers hold the same image.
   */
  private front: WebGLRenderTarget;
  private back: WebGLRenderTarget;

  /** The jittered scene colour, and its depth. Set by `Stage`. */
  source: Texture | null = null;
  depth: Texture | null = null;

  private frameIndex = 0;
  private valid = false;
  private readonly jitterOffset = new Vector2();
  private readonly prevViewProjection = new Matrix4();
  private readonly viewProjection = new Matrix4();
  private readonly inverseViewProjection = new Matrix4();
  private readonly prevCameraPosition = new Vector3();
  private readonly cameraPosition = new Vector3();
  private savedSkew = new Vector2();
  private width = 1;
  private height = 1;

  constructor(width = 1, height = 1) {
    super();

    const options = {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    } as const;
    this.front = new WebGLRenderTarget(width, height, options);
    this.back = new WebGLRenderTarget(width, height, options);
    this.width = width;
    this.height = height;

    this.material = new ShaderMaterial({
      name: "TaaPass",
      uniforms: {
        tCurrent: { value: null },
        tHistory: { value: null },
        tDepth: { value: null },
        uInverseViewProjection: { value: new Matrix4() },
        uPrevViewProjection: { value: new Matrix4() },
        uTexel: { value: new Vector2(1 / width, 1 / height) },
        uFeedback: { value: this.feedback },
        uGamma: { value: this.clampGamma },
        uValid: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tCurrent;
        uniform sampler2D tHistory;
        uniform sampler2D tDepth;
        uniform mat4 uInverseViewProjection;
        uniform mat4 uPrevViewProjection;
        uniform vec2 uTexel;
        uniform float uFeedback;
        uniform float uGamma;
        uniform float uValid;
        varying vec2 vUv;

        float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

        void main() {
          vec3 centre = texture2D(tCurrent, vUv).rgb;

          // The 3x3 neighbourhood, gathered once for both bounds: the min/max
          // box and the mean/variance the clip is built from. Nine taps of a
          // texture that is already in cache; this is the pass's whole cost.
          vec3 mn = centre;
          vec3 mx = centre;
          vec3 m1 = centre;
          vec3 m2 = centre * centre;
          #define TAP(dx, dy) { \
            vec3 c = texture2D(tCurrent, vUv + vec2(float(dx), float(dy)) * uTexel).rgb; \
            mn = min(mn, c); mx = max(mx, c); m1 += c; m2 += c * c; }
          TAP(-1, -1) TAP(0, -1) TAP(1, -1)
          TAP(-1,  0)            TAP(1,  0)
          TAP(-1,  1) TAP(0,  1) TAP(1,  1)
          #undef TAP

          vec3 mean = m1 / 9.0;
          vec3 sigma = sqrt(max(vec3(0.0), m2 / 9.0 - mean * mean));
          vec3 lo = max(mn, mean - uGamma * sigma);
          vec3 hi = min(mx, mean + uGamma * sigma);

          // Closest-depth dilation over a cross. Reprojection is camera-only,
          // so at a silhouette the background's motion would be used for a
          // pixel the foreground is about to cover; taking the nearest of the
          // five reprojects the *occluder*, which is the surface whose motion
          // the disocclusion is actually about. Four extra depth taps.
          float d = texture2D(tDepth, vUv).x;
          vec2 duv = vec2(0.0);
          #define DEPTH(dx, dy) { \
            vec2 o = vec2(float(dx), float(dy)) * uTexel; \
            float s = texture2D(tDepth, vUv + o).x; \
            if (s < d) { d = s; duv = o; } }
          DEPTH(-1, 0) DEPTH(1, 0) DEPTH(0, -1) DEPTH(0, 1)
          #undef DEPTH

          // Depth back to a world point through this frame's *unjittered*
          // matrices, then forward through the previous frame's. The jitter is
          // deliberately not in either: it is a sampling offset, not a camera
          // move, and folding it in would reproject the jitter itself and
          // cancel the entire effect.
          vec4 ndc = vec4((vUv + duv) * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          vec4 world = uInverseViewProjection * ndc;
          world /= world.w;
          vec4 reprojected = uPrevViewProjection * world;
          vec2 prevUv = reprojected.xy / reprojected.w * 0.5 + 0.5;

          // Anything that was off-screen last frame has no history worth the
          // name. Clamping to the edge instead would smear the frame border
          // inward, which is the classic TAA edge crust.
          vec2 inside = step(vec2(0.0), prevUv) * step(prevUv, vec2(1.0));
          float usable = inside.x * inside.y * uValid;

          vec3 history = texture2D(tHistory, prevUv).rgb;
          history = clamp(history, lo, hi);

          // Luminance-weighted mix, so one very hot pixel cannot dominate the
          // average and flicker. Weights divided back out, so nothing here is
          // a tone map — the chain downstream is still handed real linear
          // light.
          float blend = uFeedback * usable;
          float wc = (1.0 - blend) / (1.0 + luma(centre));
          float wh = blend / (1.0 + luma(history));
          vec3 result = (centre * wc + history * wh) / max(1e-5, wc + wh);

          gl_FragColor = vec4(result, 1.0);
        }
      `,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.material);

    // This pass does not participate in the composer's ping-pong at all: it
    // reads the scene target directly and writes into its own history, and
    // `Stage` points the chain's source `TexturePass` at `output`. The
    // alternative — writing into the composer's write buffer and swapping —
    // needs a *second* full-screen copy to get the result into the history as
    // well, and the copy the chain already performs is right there.
    this.needsSwap = false;
  }

  /** The resolved frame. What the rest of the chain should read. */
  get output(): Texture {
    return this.front.texture;
  }

  /**
   * The current frame's sub-pixel offset, in pixels. `Stage` applies it to the
   * projection matrix before drawing the scene and takes it off after.
   *
   * Halton (2,3), the standard low-discrepancy pair: sixteen offsets that fill
   * the pixel far more evenly than sixteen random ones would, and — the reason
   * it is preferred over a rotated grid — evenly at *every* prefix length, so
   * the average is already well distributed after four frames rather than only
   * after all sixteen. That matters here because the history is dropped on
   * every camera jump, so the first few frames after a jump are a case the
   * game hits constantly rather than once at start-up.
   */
  nextJitter(): Vector2 {
    const i = this.frameIndex % TaaPass.PERIOD;
    this.jitterOffset.set(
      (halton(i + 1, 2) - 0.5) * this.jitterScale,
      (halton(i + 1, 3) - 0.5) * this.jitterScale,
    );
    return this.jitterOffset;
  }

  /**
   * Apply the frame's jitter to a perspective camera's projection.
   *
   * Written straight into the projection matrix's two skew terms rather than
   * through `PerspectiveCamera.setViewOffset`, which is the other way to do
   * this: `setViewOffset` only takes whole-pixel offsets on an integer grid
   * (it is built for tiled rendering), so it cannot express a sub-pixel shift
   * at all. The saved terms are restored in `endFrame` — they are not assumed
   * to be zero, because a camera with a view offset set for some other reason
   * would have non-zero ones and this must compose with that rather than
   * stamp on it.
   */
  beginFrame(camera: PerspectiveCamera): void {
    const j = this.nextJitter();
    const e = camera.projectionMatrix.elements;
    this.savedSkew.set(e[8], e[9]);
    e[8] += (2 * j.x) / this.width;
    e[9] += (2 * j.y) / this.height;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  /**
   * Take the jitter back off and record the frame's matrices. Called after the
   * scene has been drawn, which is also the first moment `matrixWorldInverse`
   * is guaranteed fresh — three updates it inside `render`, so computing the
   * view-projection any earlier means trusting a matrix nothing has updated
   * yet.
   */
  endFrame(camera: PerspectiveCamera): void {
    const e = camera.projectionMatrix.elements;
    e[8] = this.savedSkew.x;
    e[9] = this.savedSkew.y;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    this.prevViewProjection.copy(this.viewProjection);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.inverseViewProjection.copy(this.viewProjection).invert();

    this.prevCameraPosition.copy(this.cameraPosition);
    camera.getWorldPosition(this.cameraPosition);
    if (this.cameraPosition.distanceTo(this.prevCameraPosition) > this.jumpDistance) {
      this.valid = false;
    }

    const swap = this.front;
    this.front = this.back;
    this.back = swap;

    this.frameIndex++;
  }

  /** Throw the history away — a teleport, a resize, a first frame. */
  reset(): void {
    this.valid = false;
  }

  override render(renderer: WebGLRenderer): void {
    if (this.source === null || this.depth === null) return;

    const u = this.material.uniforms;
    u.tCurrent.value = this.source;
    u.tHistory.value = this.back.texture;
    u.tDepth.value = this.depth;
    u.uInverseViewProjection.value.copy(this.inverseViewProjection);
    u.uPrevViewProjection.value.copy(this.prevViewProjection);
    u.uFeedback.value = this.feedback;
    u.uGamma.value = this.clampGamma;
    u.uValid.value = this.valid ? 1 : 0;

    // Into `front`, which `endFrame` already swapped to be the buffer the
    // chain is pointed at. The shader reads `back` and never the texture it
    // is writing.
    renderer.setRenderTarget(this.front);
    renderer.clear();
    this.quad.render(renderer);

    this.valid = true;
  }

  override setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.front.setSize(width, height);
    this.back.setSize(width, height);
    this.material.uniforms.uTexel.value.set(1 / width, 1 / height);
    this.reset();
  }

  override dispose(): void {
    this.front.dispose();
    this.back.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}

/**
 * The `base`-radix van der Corput / Halton term. Two lines, no table, and it
 * is called twice a frame — there is nothing here worth precomputing.
 */
function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}
