import {
  DepthTexture,
  Fog,
  HalfFloatType,
  NearestFilter,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  UnsignedIntType,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { TexturePass } from "three/examples/jsm/postprocessing/TexturePass.js";
import { BloomPass } from "./BloomPass.js";
import { PhosphorPass } from "./PhosphorPass.js";
import { CrtPass } from "./CrtPass.js";
import { ToneMapPass } from "./ToneMapPass.js";
import { TaaPass } from "./TaaPass.js";
import { GodRayPass } from "./GodRayPass.js";
import { resizeLineMaterials } from "./VectorObject.js";
import { enableShadows } from "./shadows.js";
import { Hud } from "../hud/Hud.js";

/**
 * Owns the render chain. The look is entirely in this order:
 *
 *   scene → TAA resolve → god rays → bloom → phosphor decay → CRT glass →
 *   tone map + encode → screen
 *
 * Bloom sits before the feedback buffer on purpose: the trail then inherits the
 * glow, so a fast-moving stroke smears as light rather than as a hard line.
 *
 * **The two temporal passes are at opposite ends of that list and that is the
 * load-bearing part of the order.** `TaaPass` resolves first, on the raw scene
 * target, because `PhosphorPass` is itself a feedback buffer and the two cannot
 * be stacked in the other order without each breaking the other — the full
 * argument, in three parts, is in `TaaPass`'s own header. The short version:
 * the phosphor's feedback is a `max()`, so handing it *unresolved* jittered
 * frames would take the union of every jitter position and fatten every line in
 * the game by a pixel; TAA's neighbourhood clamp cannot function against
 * neighbourhoods that are already trails; and depth, which reprojection needs,
 * only means anything before bloom has smeared a hot pixel across a fifth of
 * the frame.
 *
 * **Everything up to the last pass is HDR linear light and stays that way.**
 * The scene target and both composer buffers are half-float and the scene
 * genuinely uses the range — overlapping additive strokes measure 5.6x white in
 * a firefight. That is why the tone map is last and not, say, folded into the
 * bloom composite: the phosphor trail decays in real light, so a bright stroke
 * fades through the shoulder rather than plateauing at the clip point, and the
 * CRT's scanlines and vignette attenuate in real light too, which is what makes
 * scanlines vanish across a detonation instead of ruling lines over it. Both of
 * those are physical behaviours that fall out of the ordering; neither survives
 * tone mapping any earlier.
 */
export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly hud = new Hud();

  readonly bloom: BloomPass;
  readonly taa = new TaaPass();
  readonly godRays = new GodRayPass();
  readonly phosphor = new PhosphorPass();
  readonly crt = new CrtPass();
  readonly toneMap = new ToneMapPass();

  private readonly composer: EffectComposer;
  /**
   * Where the world is drawn, multisampled. See the constructor.
   *
   * Public, and its depth texture with it (`sceneDepth`). It was private, and
   * that privacy had a cost paid in a different file: `render/shaders/media.ts`
   * composites the comet's and the shoals' volumes with `depthTest: false` and
   * says so in its own header — "correct occlusion of a medium by opaque
   * geometry standing inside it needs the depth buffer as a texture, and
   * `render/Stage.ts` owns the scene target privately". The depth texture now
   * exists for TAA's reprojection whether anything else wants it or not, so
   * withholding it would be keeping a defect for no remaining reason.
   */
  readonly sceneTarget: WebGLRenderTarget;

  /** The source of the chain. Points at whatever the world's colour is *after*
   * the optional TAA resolve — see `render`. */
  private readonly source: TexturePass;

  /** Whether TAA ran last frame; see `render` for the edge it guards. */
  private taaWasEnabled = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = false;

    /**
     * Shadows on, here in the constructor, and the placement is the point.
     *
     * three bakes shadow support into every lit material's program, so
     * enabling this after materials exist relinks all of them — measured at
     * **39.8 ms in a single frame** for nine programs. Called before anything
     * lit has been built, each program is simply compiled once *with* shadows
     * and there is nothing to relink. The scene's light *count* is untouched,
     * so the far worse 170 ms figure recorded in `CLAUDE.md` never applies.
     *
     * Policy — map size, frustum extent, bias, filter — lives in
     * `render/shadows.ts`; this is only the switch.
     */
    enableShadows(this.renderer);

    // Distance fade for free: additive strokes fogged toward black simply
    // dim out, which is what a beam losing energy across the tube does.
    this.scene.fog = new Fog(0x000000, 45, 260);

    this.camera = new PerspectiveCamera(62, 1, 0.1, 2000);

    /**
     * The one buffer in this file with geometry in it, and therefore the one
     * with MSAA on.
     *
     * `antialias: true` above is not a lie, but it was nearly useless: it
     * applies to the *default* framebuffer, and the only thing this file ever
     * draws there is the HUD (see `render`). Everything in the world goes
     * through the composer, and three builds those buffers with no `samples` at
     * all — so the instruments were antialiased and every ship edge, grid line,
     * beam and stroke in the game was not. In a game whose whole art direction
     * is thin bright lines on black, that is the wrong way round.
     *
     * The obvious fix is to hand `EffectComposer` a multisampled target, which
     * it clones for its second ping-pong buffer. That was measured on an M2 Max
     * at 2560x1440 and cost 1.52ms to 4.91ms a frame — 3.2x, for four-fifths
     * nothing: the composer alternates between those two buffers, so *every*
     * pass ends up resolving a multisample buffer, and only the first one has
     * any geometry in it. Bloom, phosphor, glass and encode are full-screen
     * quads with no edges to sample.
     *
     * So the scene gets its own target instead, and the chain starts from that
     * target's texture rather than from a `RenderPass`. Reading the texture is
     * what resolves the samples, so there is exactly one resolve a frame
     * instead of five, and the passes downstream work in plain buffers on
     * already-resolved pixels — which is all they ever needed.
     *
     * `HalfFloatType` matches what the composer chooses for its own buffers:
     * the chain works in linear light and an 8-bit buffer bands visibly before
     * `ToneMapPass` ever encodes it — and, since that pass exists, an 8-bit
     * buffer would also throw away the entire range above 1.0 that the
     * highlight rolloff is there to spend. The sample count is clamped to what the GL
     * actually offers rather than assumed — four is the common ceiling and what
     * Apple silicon reports, and asking for more than the driver has is an
     * invalid-value error rather than a silent downgrade.
     */
    this.sceneTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      samples: Math.min(4, this.renderer.capabilities.maxSamples),
    });
    this.sceneTarget.texture.name = "Stage.scene";

    /**
     * Depth, as a texture rather than as the renderbuffer three would
     * otherwise allocate. Two consumers: `TaaPass` reprojects last frame's
     * pixel through it, and `GodRayPass` uses it as the occlusion buffer it is
     * not allowed to render for itself.
     *
     * `UnsignedIntType` — 24-bit, no stencil. `DepthTexture`'s own default is
     * the same 24-bit depth, and this is written out to state that the
     * *float* option was considered and declined: a float depth target would
     * cost twice the bandwidth on the MSAA resolve for precision this has no
     * use for. Reprojection only has to land within a texel, and 24 bits is
     * three orders of magnitude finer than that even at the far plane.
     * `NearestFilter` because a depth value between two surfaces is a value
     * from neither.
     *
     * Note the resolve this adds: with `samples > 0` three keeps a
     * multisampled framebuffer and blits it into this one, and
     * `resolveDepthBuffer` (default true) is what makes that blit carry
     * `DEPTH_BUFFER_BIT` as well as colour. That is the whole cost of having
     * depth at all, and it was measured rather than assumed — at 3024x1964,
     * with both new passes off, **6.46 ms with the depth resolve against 6.24
     * ms without: 0.22 ms**. It is left on unconditionally rather than
     * switched with the passes that want it, which is a real 0.22 ms and
     * therefore a real decision: `shaders/media.ts` wants it too, and a depth
     * texture that only exists while an unrelated display toggle happens to be
     * on is a worse thing to build against than one that always does.
     */
    this.sceneTarget.depthTexture = new DepthTexture(1, 1, UnsignedIntType);
    this.sceneTarget.depthTexture.minFilter = NearestFilter;
    this.sceneTarget.depthTexture.magFilter = NearestFilter;
    this.sceneTarget.depthTexture.name = "Stage.depth";

    /**
     * `NoToneMapping` is the default and is here to be *stated*, because the
     * obvious way to do what `ToneMapPass` does is to set this field instead
     * and let `OutputPass` pick the operator up — and that route is closed
     * twice over. In three r185 a non-default value makes `WebGLRenderer.render`
     * route canvas renders through an internal `WebGLOutput` composite of its
     * own, which would both double-apply against the chain's own output pass
     * and stamp on the scene-then-HUD composite in `render` below; and the
     * per-material half of the same switch would tone-map the HUD, which is
     * drawn direct to the canvas and is the one thing here authored in display
     * values. See `ToneMapPass` for the tonal half of the argument.
     */
    this.renderer.toneMapping = NoToneMapping;

    this.composer = new EffectComposer(this.renderer);

    /**
     * TAA resolves ahead of the chain's own source rather than inside it: it
     * reads the scene target directly, writes into its own history pair, and
     * the `TexturePass` below is then pointed at whichever of the two is
     * current. That is why it is worth doing it this way round — the chain
     * already begins with a full-screen copy, so routing the resolve through
     * it makes temporal antialiasing cost exactly one extra pass instead of
     * two. Writing into the composer's own write buffer and swapping, the
     * ordinary arrangement, would still need a second copy to get the result
     * into the history.
     *
     * It also means `taa.enabled = false` is a genuine bypass with nothing
     * left behind: `render` points the source back at the scene target and the
     * chain is bit-for-bit what it was.
     */
    this.taa.source = this.sceneTarget.texture;
    this.taa.depth = this.sceneTarget.depthTexture;
    this.composer.addPass(this.taa);

    this.source = new TexturePass(this.sceneTarget.texture);
    this.composer.addPass(this.source);

    /**
     * Shafts before bloom, so light in gas blooms like the light it is, and
     * after TAA, so the radial blur is taken from a resolved frame — a blur of
     * a jittered frame shimmers along the ray direction, which is the one
     * place in the chain nothing else shimmers.
     */
    this.godRays.depth = this.sceneTarget.depthTexture;
    this.composer.addPass(this.godRays);

    // Multi-scale glare rather than `UnrealBloomPass`. The whole argument is
    // in `BloomPass` — the short version is that a hard threshold and a single
    // blur width are the two things a screen of thin bright lines is worst
    // served by, and that the pyramid is also cheaper than what it replaced.
    this.bloom = new BloomPass();
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.phosphor);
    this.composer.addPass(this.crt);

    // Everything above works in HDR linear light. This is where it becomes a
    // picture: highlights roll off instead of clipping flat, and the result is
    // sRGB-encoded — without which the composer would write linear values
    // straight to the display and every dim trace (grid, starfield, low shield
    // charge) is crushed to black, while the HUD, rendered direct to the canvas
    // and therefore encoded, looks correct. Always on: it is colour
    // correctness, not an effect. Replaces `OutputPass`, which did the encode
    // alone.
    this.composer.addPass(this.toneMap);

    this.setSize(window.innerWidth, window.innerHeight);
  }

  setSize(width: number, height: number): void {
    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    // In device pixels, the way the composer sizes its own buffers — the pass
    // chain reads this texture and every one of them is measured the same way.
    this.sceneTarget.setSize(width * pixelRatio, height * pixelRatio);
    // `RenderTarget.setSize` does not carry the size across to an attached
    // depth texture; three only reconciles the two when it next sets the
    // framebuffer up, and `WebGLRenderer.setRenderTarget` throws outright if it
    // finds them disagreeing first. Kept in step here rather than relying on
    // the order those two happen to run in.
    if (this.sceneTarget.depthTexture !== null) {
      this.sceneTarget.depthTexture.image.width = width * pixelRatio;
      this.sceneTarget.depthTexture.image.height = height * pixelRatio;
      this.sceneTarget.depthTexture.needsUpdate = true;
    }

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // Fat lines and the CRT scanlines both work in device pixels.
    resizeLineMaterials(width * pixelRatio, height * pixelRatio);
    this.crt.setSize(width * pixelRatio, height * pixelRatio);
    this.hud.setSize(width, height);
  }

  render(dt: number): void {
    this.phosphor.delta = dt;

    // Switching TAA back on is a teleport as far as the history is concerned:
    // `endFrame` stopped recording view-projections while it was off, so the
    // first frame back would reproject through a matrix from whenever it was
    // switched off and fetch a ghost of that frame. Cheaper to notice the edge
    // than to keep recording matrices for a pass that is not running.
    if (this.taa.enabled && !this.taaWasEnabled) this.taa.reset();
    this.taaWasEnabled = this.taa.enabled;

    // A sub-pixel nudge on the projection, so that successive frames sample
    // the pixel in different places and the resolve below can average them
    // back into the coverage a single frame cannot express. Taken off again in
    // `endFrame`, before anything else can see it: the HUD is drawn with its
    // own camera and `main.ts` reads this one for target markers, and neither
    // should ever meet a jittered matrix.
    if (this.taa.enabled) this.taa.beginFrame(this.camera);

    // The world, into its own multisampled buffer. Explicitly cleared because
    // `autoClear` is off for the two-part composite at the bottom of this
    // method, so nothing else is going to do it — a `RenderPass` used to, and
    // this is the half of its job that had to come with it.
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // After the scene, not before: `matrixWorldInverse` is updated inside
    // `render`, and the view-projection this records for next frame's
    // reprojection has to be the one the frame was actually drawn with.
    if (this.taa.enabled) this.taa.endFrame(this.camera);
    this.source.map = this.taa.enabled ? this.taa.output : this.sceneTarget.texture;

    // Where the lights are on screen this frame. Cheap, and outside the pass
    // because it needs the camera and the scene, which the composer does not
    // hand a pass.
    if (this.godRays.enabled) {
      this.godRays.setClip(this.camera.near, this.camera.far);
      this.godRays.aim(this.scene, this.camera);
    }

    // ...and the chain, which begins by reading the scene buffer — the read is
    // what resolves the samples.
    this.composer.render();

    // The HUD is composited after the glass so readouts stay crisp and are not
    // dragged around by barrel distortion — the instruments are meant to be on
    // this side of the screen, not inside the tube.
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.hud.scene, this.hud.camera);
  }

  setPassEnabled(pass: { enabled: boolean }, enabled: boolean): void {
    pass.enabled = enabled;
  }

  dispose(): void {
    this.taa.dispose();
    this.godRays.dispose();
    this.bloom.dispose();
    this.phosphor.dispose();
    this.crt.dispose();
    this.toneMap.dispose();
    this.composer.dispose();
    this.sceneTarget.dispose();
    this.renderer.dispose();
  }

  /** Exposed for passes that need to know the working buffer size. */
  get target(): WebGLRenderTarget {
    return this.composer.renderTarget1;
  }

  /**
   * The scene's depth, resolved, in device pixels. For anything that has to
   * composite against the world rather than over it — `shaders/media.ts`'s
   * volumes above all, which currently give up depth testing entirely because
   * this was unreachable.
   */
  get sceneDepth(): DepthTexture | null {
    return this.sceneTarget.depthTexture;
  }
}
