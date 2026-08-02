import {
  Fog,
  PerspectiveCamera,
  Scene,
  Vector2,
  WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
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

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

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

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // Fat lines and the CRT scanlines both work in device pixels.
    resizeLineMaterials(width * pixelRatio, height * pixelRatio);
    this.crt.setSize(width * pixelRatio, height * pixelRatio);
    this.hud.setSize(width, height);
  }

  render(dt: number): void {
    this.phosphor.delta = dt;
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
    this.renderer.dispose();
  }

  /** Exposed for passes that need to know the working buffer size. */
  get target(): WebGLRenderTarget {
    return this.composer.renderTarget1;
  }
}
