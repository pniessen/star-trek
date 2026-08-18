import {
  Fog,
  HalfFloatType,
  PerspectiveCamera,
  Scene,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { TexturePass } from "three/examples/jsm/postprocessing/TexturePass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { PhosphorPass } from "./PhosphorPass.js";
import { CrtPass } from "./CrtPass.js";
import { resizeLineMaterials } from "./VectorObject.js";
import { Hud } from "../hud/Hud.js";

/**
 * Owns the render chain. The look is entirely in this order:
 *
 *   scene → bloom → phosphor decay → CRT glass → screen
 *
 * Bloom sits before the feedback buffer on purpose: the trail then inherits the
 * glow, so a fast-moving stroke smears as light rather than as a hard line.
 */
export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly hud = new Hud();

  readonly bloom: UnrealBloomPass;
  readonly phosphor = new PhosphorPass();
  readonly crt = new CrtPass();

  private readonly composer: EffectComposer;
  /** Where the world is drawn, multisampled. See the constructor. */
  private readonly sceneTarget: WebGLRenderTarget;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = false;

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
     * `OutputPass` ever encodes it. The sample count is clamped to what the GL
     * actually offers rather than assumed — four is the common ceiling and what
     * Apple silicon reports, and asking for more than the driver has is an
     * invalid-value error rather than a silent downgrade.
     */
    this.sceneTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      samples: Math.min(4, this.renderer.capabilities.maxSamples),
    });
    this.sceneTarget.texture.name = "Stage.scene";

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new TexturePass(this.sceneTarget.texture));

    // Threshold high enough that only traces bloom, strength low enough that a
    // ship at combat range stays a silhouette instead of an orange smear. Small
    // distant objects are the constraint here, not the hero shot.
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), 0.82, 0.45, 0.5);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.phosphor);
    this.composer.addPass(this.crt);

    // Everything above works in linear light. Without this final encode the
    // composer writes linear values straight to an sRGB display and every dim
    // trace — grid, starfield, low shield charge — is crushed to black, while
    // the HUD (rendered direct to the canvas, and therefore encoded) looks
    // correct. Always on: it is colour correctness, not an effect.
    this.composer.addPass(new OutputPass());

    this.setSize(window.innerWidth, window.innerHeight);
  }

  setSize(width: number, height: number): void {
    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    // In device pixels, the way the composer sizes its own buffers — the pass
    // chain reads this texture and every one of them is measured the same way.
    this.sceneTarget.setSize(width * pixelRatio, height * pixelRatio);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // Fat lines and the CRT scanlines both work in device pixels.
    resizeLineMaterials(width * pixelRatio, height * pixelRatio);
    this.crt.setSize(width * pixelRatio, height * pixelRatio);
    this.hud.setSize(width, height);
  }

  render(dt: number): void {
    this.phosphor.delta = dt;

    // The world, into its own multisampled buffer. Explicitly cleared because
    // `autoClear` is off for the two-part composite at the bottom of this
    // method, so nothing else is going to do it — a `RenderPass` used to, and
    // this is the half of its job that had to come with it.
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // ...and the chain, which begins by reading that buffer — the read is what
    // resolves the samples.
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
    this.phosphor.dispose();
    this.crt.dispose();
    this.composer.dispose();
    this.sceneTarget.dispose();
    this.renderer.dispose();
  }

  /** Exposed for passes that need to know the working buffer size. */
  get target(): WebGLRenderTarget {
    return this.composer.renderTarget1;
  }
}
