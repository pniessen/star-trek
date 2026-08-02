import { ShaderMaterial, Vector2, type WebGLRenderer, type WebGLRenderTarget } from "three";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * The glass in front of the beam: barrel distortion, scanlines, vignette and a
 * touch of channel separation toward the edges.
 *
 * Kept deliberately restrained and fully toggleable. This is the effect most
 * likely to tip the look from "drawn in light" into "emulator screenshot", so
 * the defaults sit well under what reads as a filter.
 */
export class CrtPass extends Pass {
  private readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor() {
    super();

    this.material = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new Vector2(1, 1) },
        uCurvature: { value: 0.055 },
        uScanline: { value: 0.16 },
        uVignette: { value: 0.42 },
        uAberration: { value: 0.9 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 uResolution;
        uniform float uCurvature;
        uniform float uScanline;
        uniform float uVignette;
        uniform float uAberration;
        varying vec2 vUv;

        vec2 barrel(vec2 uv, float amount) {
          vec2 c = uv * 2.0 - 1.0;
          c *= 1.0 + amount * dot(c, c);
          return c * 0.5 + 0.5;
        }

        void main() {
          vec2 uv = barrel(vUv, uCurvature);

          // Off-screen after distortion is bezel, not content.
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          // Convergence error grows toward the corners, as on a real tube.
          vec2 fromCentre = uv - 0.5;
          float spread = uAberration / uResolution.x * dot(fromCentre, fromCentre) * 8.0;
          vec3 colour = vec3(
            texture2D(tDiffuse, uv + fromCentre * spread).r,
            texture2D(tDiffuse, uv).g,
            texture2D(tDiffuse, uv - fromCentre * spread).b
          );

          // Scanlines tied to device pixels, so they stay one line thick at
          // any resolution instead of moiring on high-DPI displays.
          float line = sin(uv.y * uResolution.y * 3.14159);
          colour *= 1.0 - uScanline * line * line;

          float vig = 1.0 - uVignette * dot(fromCentre, fromCentre) * 2.0;
          colour *= clamp(vig, 0.0, 1.0);

          gl_FragColor = vec4(colour, 1.0);
        }
      `,
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
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  override setSize(width: number, height: number): void {
    this.material.uniforms.uResolution.value.set(width, height);
  }

  override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
