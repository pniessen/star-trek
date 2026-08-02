import {
  HalfFloatType,
  LinearFilter,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * Phosphor persistence.
 *
 * A real vector monitor's beam left a decaying trail — bright strokes lingered
 * for a few frames and fast motion smeared. We reproduce it with a feedback
 * buffer: each frame the previous output is dimmed and taken as a floor under
 * the new one, so nothing brightens spuriously but everything fades out over
 * time rather than snapping to black.
 *
 * Decay is per-channel because phosphors were never neutral: the blue-green end
 * of the trace hangs on longer than the red, which is what stops the trail from
 * reading as a plain grey ghost.
 */
export class PhosphorPass extends Pass {
  private readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private accum: WebGLRenderTarget;
  private previous: WebGLRenderTarget;

  /**
   * Fraction of the trail surviving each 60th of a second. 0 = no persistence,
   * ~0.92 = long lazy trails. Expressed per unit time rather than per frame:
   * a trail that lengthens when the machine is slow is a bug, not a look.
   */
  decay = 0.74;

  /** Seconds since the previous frame; set by the game loop. */
  delta = 1 / 60;

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
    this.accum = new WebGLRenderTarget(width, height, options);
    this.previous = new WebGLRenderTarget(width, height, options);

    this.material = new ShaderMaterial({
      uniforms: {
        tCurrent: { value: null },
        tPrevious: { value: null },
        uDecay: { value: this.decay },
        uTexel: { value: new Vector2(1 / width, 1 / height) },
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
        uniform sampler2D tPrevious;
        uniform float uDecay;
        uniform vec2 uTexel;
        varying vec2 vUv;

        void main() {
          vec4 current = texture2D(tCurrent, vUv);

          // Bleed the trail outward by a texel as it fades. Without this the
          // ghost is a pixel-exact copy and reads as a rendering bug rather
          // than as glowing phosphor still giving up its charge.
          vec3 prev = texture2D(tPrevious, vUv).rgb * 4.0;
          prev += texture2D(tPrevious, vUv + vec2(uTexel.x, 0.0)).rgb;
          prev += texture2D(tPrevious, vUv - vec2(uTexel.x, 0.0)).rgb;
          prev += texture2D(tPrevious, vUv + vec2(0.0, uTexel.y)).rgb;
          prev += texture2D(tPrevious, vUv - vec2(0.0, uTexel.y)).rgb;
          prev /= 8.0;

          // Cap what the history is allowed to carry. The scene is HDR — a
          // bloomed stroke can be many times white — and an uncapped trail sits
          // above the clipping point for dozens of frames, reading as burn-in
          // that vanishes all at once instead of a trail that fades.
          prev = min(prev, vec3(1.8));

          // Per-channel decay: the blue-green trace outlives the red.
          vec3 decayed = prev * vec3(uDecay * 0.94, uDecay, uDecay * 1.02);

          gl_FragColor = vec4(max(current.rgb, decayed), current.a);
        }
      `,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.material);
    this.needsSwap = true;
  }

  override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    // Per-frame survival derived from elapsed time, so the trail is the same
    // length at 60fps and at 400.
    const frameDecay = Math.pow(this.decay, Math.max(this.delta, 1e-4) * 60);
    this.material.uniforms.uDecay.value = frameDecay;
    this.material.uniforms.tCurrent.value = readBuffer.texture;
    this.material.uniforms.tPrevious.value = this.previous.texture;

    // Composite into our own accumulator so the history survives the
    // composer's read/write buffer swapping.
    renderer.setRenderTarget(this.accum);
    renderer.clear();
    this.quad.render(renderer);

    // Blit the accumulator to whichever buffer comes next in the chain.
    this.material.uniforms.tCurrent.value = this.accum.texture;
    this.material.uniforms.tPrevious.value = this.previous.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.copyTo(renderer, this.accum);

    const swap = this.previous;
    this.previous = this.accum;
    this.accum = swap;
  }

  /** Straight copy of `source` into the currently bound target. */
  private copyTo(renderer: WebGLRenderer, source: WebGLRenderTarget): void {
    const composited = this.material.uniforms.uDecay.value;
    this.material.uniforms.tCurrent.value = source.texture;
    this.material.uniforms.uDecay.value = 0; // history contributes nothing
    this.quad.render(renderer);
    this.material.uniforms.uDecay.value = composited;
  }

  override setSize(width: number, height: number): void {
    this.accum.setSize(width, height);
    this.previous.setSize(width, height);
    this.material.uniforms.uTexel.value.set(1 / width, 1 / height);
  }

  override dispose(): void {
    this.accum.dispose();
    this.previous.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
