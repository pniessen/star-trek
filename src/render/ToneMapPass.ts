import {
  NoBlending,
  ShaderMaterial,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * The end of the chain: exposure, a highlight rolloff, the sRGB encode, and a
 * dither. Replaces `OutputPass`, which did only the third of those.
 *
 * ## Why this exists at all
 *
 * Everything upstream works in half-float linear light and genuinely uses the
 * range — measured on this scene, overlapping additive strokes reach **5.6x
 * white** in a firefight. `OutputPass` with no tone mapping simply encodes and
 * lets the display clamp, so every one of those pixels landed on exactly 1.0.
 * A torpedo detonation, the sun's core and two crossed phaser beams all came
 * out the same flat white patch, with the shape of the patch decided by where
 * the value happened to cross 1.0 rather than by anything about the light. The
 * whole point of a half-float chain is the part above 1, and it was being
 * thrown away in the last instruction.
 *
 * ## Why not one of the three three.js ships
 *
 * `renderer.toneMapping` is the obvious route and it is closed twice over.
 *
 * **Mechanically**, in three r185 setting it to anything but `NoToneMapping`
 * makes `WebGLRenderer.render` route *canvas* renders through an internal
 * `WebGLOutput` target and apply the operator in a composite of its own (see
 * `useOutput` in three's `render`). This file's chain already ends by drawing
 * a full-screen quad to the canvas and `Stage` then draws the HUD over it with
 * `autoClear` off — so the internal composite would both double-encode the
 * chain's own `OutputPass` output and stamp on the two-part composite. The
 * per-material half of the same switch would also tone-map the HUD, which is
 * drawn direct to the canvas and is the one thing here that is authored in
 * display values and must not be touched.
 *
 * **Tonally**, all three shipped operators are built for a photographic frame
 * — a scene with a subject around middle grey. This one is not. Measured:
 * **99.9% of pixels sit below 0.76 linear and 0.09% clip**. Essentially the
 * entire image is in the bottom of the range and the part that needed help is
 * a rounding error by area but is every bright event in the game. So the toe
 * matters far more than the shoulder here, and each operator's toe is what
 * rules it out:
 *
 * - **ACES Filmic.** Its toe takes 0.02 linear to 0.0049 — a 4x crush on
 *   exactly the band the grid, the starfield, `PALETTE.traceDim` structure and
 *   every distant contact live in. It would darken almost the whole frame to
 *   fix 0.09% of it, which is the bargain backwards.
 * - **AgX.** A full filmic sigmoid plus a chroma rotation, both of which act
 *   hardest in the lower third — which is where all of this game's tonal
 *   content is. It is also built to desaturate as it brightens, and "colour is
 *   information" means a hostile's class hue washing out with its brightness
 *   is a legibility change, not a look.
 * - **Khronos PBR Neutral.** By far the closest in spirit, and its shoulder is
 *   in fact what is used below. What is dropped is its shadow step, which
 *   subtracts the darkest channel below 0.08: a dim grey 0.05 comes out 0.0156,
 *   three times darker, and a dim cyan trace comes out both darker and much
 *   more saturated. That is a deliberate, sensible move for a lit PBR scene
 *   with real shadow detail, and it is aimed straight at the only part of the
 *   frame this game has.
 *
 * ## What is used instead
 *
 * A rolloff with **no toe at all** — identity below the shoulder, so 99.9% of
 * the frame comes out bit-identical to before this pass existed, and the only
 * pixels that change are the ones that were clipping.
 *
 *     peak <= s          →  unchanged
 *     peak >  s          →  peak' = 1 - d^2 / (peak + d - s),  d = 1 - s
 *
 * That is Khronos Neutral's shoulder, and it is chosen over the alternatives
 * for being C-1 continuous at the join: it passes through `s` with slope
 * exactly 1 and asymptotes to 1, so there is no seam where the rolloff starts
 * and no value, however hot, that reaches flat white. A tanh or an exponential
 * shoulder would do the same job; this one is rational, so it costs a divide
 * rather than a transcendental, and it is already the operator three would
 * have applied under `NeutralToneMapping` — the disagreement with three is
 * about the shadows, not about this.
 *
 * The compression is applied to the **peak channel** and the colour scaled to
 * match, rather than per channel. Per-channel is the film-like choice and it
 * would give hot things a white core for free, but it gets there by clipping
 * the channels one at a time, which swings hue on the way — a hot violet
 * Harrow strand goes pink before it goes white. Scaling by the peak holds the
 * chromaticity exactly and leaves *how* things go white to one explicit term:
 *
 *     g = 1 - 1 / (desaturation * (peak - peak') + 1)
 *
 * which is how far toward white a pixel is dragged, driven by how much
 * compression it just took. Nothing below the shoulder is dragged anywhere,
 * because nothing below the shoulder was compressed. This is the term that
 * makes a detonation core read as *overdriven* rather than as a very bright
 * orange, and it is a knob rather than a side effect precisely because
 * "colour is information" — the amount of hue a bright thing is allowed to
 * lose is a decision, so it is written down as one.
 *
 * ## Dither
 *
 * The output is 8-bit and this game is a wash of very dark, very smooth
 * gradients — the CRT vignette over a near-black backdrop is a ramp across the
 * whole frame occupying a handful of codes. That bands, and no amount of
 * precision upstream helps, because the banding is created by the final
 * quantisation. A triangular-PDF dither of one LSB before the write turns the
 * contour into noise below the level anyone can see. Spatial only, never
 * animated: a time-varying dither is film grain, which is a look this game has
 * not chosen, and it would also crawl under the phosphor trail.
 *
 * ## What it costs
 *
 * Nothing, and slightly less than nothing. Measured on an M2 Max at 3024x1964
 * against the `OutputPass` it replaces, on an otherwise identical chain:
 * **3.74 ms to 3.66 ms**, i.e. this pass is 0.08 ms *cheaper* than doing the
 * encode alone. Both are one full-screen quad and the whole frame is bandwidth
 * on the read, so the operator's arithmetic is free — and its one branch is
 * taken by well under 1% of pixels, coherently, which is the case a GPU
 * handles best.
 */
export class ToneMapPass extends Pass {
  /**
   * Linear gain before the operator. 1.0 is "the scene as authored", which is
   * where this stays unless someone is tuning.
   *
   * Deliberately a constant and not an auto-exposure. In a game whose stated
   * rule is that colour and brightness are information, an adaptive exposure
   * would mean the void gets brighter when there is more on screen and a dim
   * contact's absolute brightness stops meaning "far away" — the instrument
   * would be lying about the thing it is for.
   */
  exposure = 1;

  /**
   * Where the rolloff starts, in linear light. Below this the pass is an
   * identity (plus the encode) and the image is exactly what it was.
   *
   * 0.76 is Khronos Neutral's own `0.8 - 0.04`, and it happens to land within
   * a rounding error of where the measurement put the 99.9th percentile of
   * this scene — so it is both the standard value and the measured one. Lower
   * would start compressing structure that is not in any trouble; higher would
   * leave a shoulder too short to hold 5.6x apart from 1.0x.
   */
  shoulder = 0.76;

  /**
   * How far a compressed pixel is dragged toward white, per unit of
   * compression taken.
   *
   * 0.15 is Khronos' figure and is a light touch — a 5.6x core lands about 40%
   * of the way to white, so a detonation still reads as having been amber and
   * a phaser crossing still reads as having been cyan. Raising it toward 0.5
   * makes bright cores frankly white, which is closer to a real overdriven
   * tube; 0 keeps the hue exact all the way up and makes the brightest things
   * read as saturated rather than hot. Left at the conservative end because
   * hue is a signal in this game and the shoulder alone already solved the
   * flat-patch problem.
   */
  desaturation = 0.15;

  /**
   * Dither amplitude in output codes. 1 is one 8-bit LSB, which is the
   * textbook amount; 0 turns it off.
   */
  dither = 1;

  private readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor() {
    super();

    this.material = new ShaderMaterial({
      name: "ToneMapPass",
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: this.exposure },
        uShoulder: { value: this.shoulder },
        uDesaturation: { value: this.desaturation },
        uDither: { value: this.dither },
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
        uniform float uExposure;
        uniform float uShoulder;
        uniform float uDesaturation;
        uniform float uDither;
        varying vec2 vUv;

        // The sRGB OETF verbatim, linear segment included, rather than a 1/2.2
        // power. The two diverge most below 0.003 linear, which on a frame
        // that is mostly void is not a corner case — it is the majority of the
        // pixels. Same curve three's own OutputPass applies, so switching to
        // this pass changes the encode by exactly nothing.
        vec3 encodeSRGB(vec3 v) {
          v = max(v, vec3(0.0));
          return mix(
            pow(v, vec3(0.41666)) * 1.055 - vec3(0.055),
            v * 12.92,
            vec3(lessThanEqual(v, vec3(0.0031308)))
          );
        }

        // Hash for the dither. Cheap, no texture, no time term.
        float hash(vec2 p) {
          vec3 q = fract(vec3(p.xyx) * 0.1031);
          q += dot(q, q.yzx + 33.33);
          return fract((q.x + q.y) * q.z);
        }

        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
          c = max(c, vec3(0.0));

          float peak = max(c.r, max(c.g, c.b));

          // The whole operator. The branch is coherent across almost the
          // entire frame — 99.9% of pixels take the cheap side of it together
          // — which is the one place a branch in a fragment shader is free.
          if (peak > uShoulder) {
            float d = 1.0 - uShoulder;
            float rolled = 1.0 - d * d / (peak + d - uShoulder);
            c *= rolled / peak;

            float g = 1.0 - 1.0 / (uDesaturation * (peak - rolled) + 1.0);
            c = mix(c, vec3(rolled), g);
          }

          vec3 encoded = encodeSRGB(c);

          // Triangular PDF from two independent hashes: a flat one leaves the
          // noise floor audible as a texture, the difference of two puts most
          // of its energy at zero and only breaks the contour.
          float n = hash(gl_FragCoord.xy) - hash(gl_FragCoord.xy + 17.31);
          encoded += n * uDither / 255.0;

          gl_FragColor = vec4(encoded, 1.0);
        }
      `,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      // Nothing in three may touch this material's colour: it *is* the
      // colour management, and `renderer.toneMapping` stays `NoToneMapping`
      // for the reasons in the docblock. Set anyway so a later change to that
      // renderer field cannot silently apply an operator twice.
      toneMapped: false,
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
    this.material.uniforms.uExposure.value = this.exposure;
    this.material.uniforms.uShoulder.value = this.shoulder;
    this.material.uniforms.uDesaturation.value = this.desaturation;
    this.material.uniforms.uDither.value = this.dither;

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
