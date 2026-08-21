import {
  AdditiveBlending,
  HalfFloatType,
  LinearFilter,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type PerspectiveCamera,
  type PointLight,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from "three";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { EVENT_LIGHT } from "./eventLights.js";

/**
 * Volumetric light shafts — the star's, and a warhead's.
 *
 * ## What it actually computes
 *
 * The classic (Mitchell, *GPU Gems 3* ch. 13): a radial blur of the frame away
 * from the light's screen position. Every pixel walks a short line toward the
 * light and sums what it finds, so a bright source smears outward into rays
 * and anything standing in the way carves the gaps between them. It is an
 * approximation of an in-scattering integral that only holds when the light is
 * roughly on screen — and it is the right approximation for this game, because
 * the alternative (a world-space march through a participating medium) is
 * already built here for the one place it belongs. `CometMedium` owns the
 * comet's tail, at the comet's own cost, and the comet's interference is a
 * *rule* the game enforces. Shafts are scenery. Scenery does not get to spend
 * the tail's budget.
 *
 * Two things are done differently from the textbook, and both come from the
 * same fact: the textbook renders a dedicated occlusion buffer — a second pass
 * over the scene with a black override material and the light drawn bright —
 * and this file may not.
 *
 * **The source is the frame itself, masked by depth.** The scene's own colour
 * *is* the occlusion buffer if you keep only what is far away and bright:
 * beyond `occluderFar` the pixel is sky, a hero body, or the sun's own disc,
 * all legitimate emitters of a shaft; nearer than `occluderNear` it is a hull,
 * an asteroid or a beam, all things a shaft should break against. The soft
 * luminance knee that follows is `BloomPass`'s argument in miniature — a hard
 * threshold makes a body pop into raying as it brightens.
 *
 * The reason it must be this way rather than an override pass is worth
 * recording, because "render the scene again in black" is the obvious move and
 * it is not merely expensive here, it is *wrong*: `scene.overrideMaterial`
 * replaces every material in the scene, which would turn `Backdrop`'s
 * camera-pinned sky — deliberately `depthWrite: false`, deliberately behind
 * everything — into a solid black occluder covering the entire frame, and
 * there would be no shafts at all. Getting that right needs per-object layer
 * assignments in a file this one is not allowed to touch and should not want
 * to. Depth is already a property of the scene, it is already being written
 * correctly by exactly the objects that should occlude, and `Stage` now
 * resolves it for TAA regardless. The mask is free.
 *
 * **The event lights get their own term.** A torpedo detonation is *near*, so
 * the depth mask deletes it from the source buffer before the radial blur ever
 * sees it — correct for the star (a beam three metres from the camera must not
 * smear toward the sun) and useless for the warhead. So a point light is
 * marched separately, with the occlusion test it actually wants: a sample is
 * lit if the depth there is *behind the light*, which is a comparison the star
 * cannot make (it has no finite depth) and the warhead can. That is what makes
 * a hull silhouetted against a detonation throw a shadow through the gas
 * instead of being lit through.
 *
 * ## What it costs, and where
 *
 * Three draws: an extract at quarter resolution (2 taps), the march at quarter
 * resolution (a long loop over a small texture that stays in cache), and one
 * full-resolution additive composite. The shafts are the blurriest thing in
 * the frame, so quarter resolution is not a concession — a full-resolution
 * march would be spending sixteen times the fill to compute the same low
 * frequencies. The one artefact quarter resolution *does* produce is stepping
 * along the march, and that is answered by a per-pixel dither on the start
 * offset rather than by more samples: the banding becomes noise, and the noise
 * lands under the bloom.
 *
 * ## Where it sits
 *
 * Between TAA and bloom. Before bloom because a shaft is light and should
 * bloom like light. After TAA because the source is the resolved frame — a
 * radial blur of a jittered frame is a radial blur of a jittered frame, and it
 * would shimmer along the ray direction where nothing else in the chain
 * shimmers at all.
 */
export class GodRayPass extends Pass {
  /**
   * Gain on the star's shafts, as a multiplier on the sampled scene light they
   * are made of. Below ~0.2 the effect is a suspicion; above ~0.9 the void
   * stops being black, which is the one thing this game's frame may not lose.
   */
  strength = 0.42;

  /**
   * How far along the line toward the light a pixel samples, as a fraction of
   * the distance to it.
   *
   * 1.0, and the reason is measured rather than aesthetic. This was 0.85 —
   * "not quite to the source" seemed the safer default, and it is not: with
   * the march stopping 15% short, the nearest sample any pixel takes is at
   * 0.15 of its own distance from the light, so a pixel further out than about
   * six source-radii never samples the source at all and gets *nothing*. The
   * measured result was 13 pixels in a 1200x900 crop changed by more than
   * 2.4%. At 1.0 the last sample lands on the source itself, which is what
   * makes a compact bright body throw anything at all. Lower is for a
   * deliberately hazy, sourceless look, not for a subtler version of this one.
   */
  density = 1;

  /**
   * Per-sample falloff along the march. The weight of a sample at step `i` is
   * `decay^i`, so this is what decides whether the shafts are long and even
   * (near 1) or a tight flare around the source (0.9 and below). Compounds
   * with `SAMPLES` — 0.97^32 is 0.38, so the far end of the march still counts
   * for a third of the near end.
   */
  decay = 0.97;

  /**
   * Where the luminance knee sits, in linear light. Anything dimmer than this
   * contributes almost nothing to a shaft.
   *
   * 0.35, and it is measured rather than guessed. A histogram of the scene
   * target on a real in-run frame (600x400 crop, half-float readback): median
   * linear luminance **0.058**, 99th percentile **0.108**, 99.9th **0.75**,
   * maximum **0.85**. That is not a smooth distribution with a tail — it is
   * two populations with an empty gap between them, the wash of backdrop and
   * nebula on one side and the handful of genuinely bright pixels on the
   * other. Any threshold in 0.15..0.55 selects the same 0.3% of the frame, so
   * the knee is put in the middle of the gap where neither population's
   * drifting can reach it. Below ~0.11 the entire sky starts contributing and
   * the shafts become a fog over the void, which is the one thing this frame
   * may not lose.
   */
  threshold = 0.35;

  /**
   * View-space distances, in world units, over which a pixel stops being an
   * occluder and starts being a source. Nearer than `occluderNear` a pixel
   * contributes nothing and therefore casts a shaft-shaped hole; beyond
   * `occluderFar` it contributes fully.
   *
   * The pair is set from what the scene actually contains rather than by
   * taste: engagement ranges run 14-78 units (`CLAUDE.md`), asteroid fields
   * sit across combat space, and the nearest a hero body can ever be is
   * `GIANT.minRange` 550 less its own 215 radius — 335. Anything between those
   * two facts is a free choice, and the ramp is put at the near end of it so
   * that a body which has come close still rays.
   */
  occluderNear = 120;
  occluderFar = 320;

  /**
   * Gain on the event lights' own shafts, in linear light at the centre of an
   * unoccluded flash of the star's own intensity, and how many lights may
   * throw one at once. The count is a cost ceiling, not a design one: each
   * light is its own march, so it multiplies the expensive half of the shader.
   * Three is two torpedoes and a breach.
   *
   * 0.05 is small and is meant to be. Measured against the same histogram
   * `threshold` cites, the *median* pixel in this game is 0.058 linear — so
   * this is "a warhead roughly doubles the light in the volume around it",
   * which at a detonation's real size is a large effect. The first draft of
   * this number was 0.55, and measuring it was how that was found out: it
   * added 134/255 of luminance to the mean of the whole frame, i.e. it turned
   * the void grey.
   */
  eventStrength = 0.05;
  eventLights = 3;

  /**
   * How tightly an event light's shafts hug it on screen, as a radius in
   * screen heights. A warhead lights its own neighbourhood; without this the
   * streaks reach the frame edge and read as a lens artefact rather than as
   * light in gas.
   */
  eventFalloff = 0.35;

  /**
   * Resolution divisor for the extract and the march. 4 is quarter-linear —
   * a sixteenth of the fill. 2 is visibly no better on this content and costs
   * four times as much.
   */
  readonly divisor = 4;

  private readonly extractMaterial: ShaderMaterial;
  private readonly marchMaterial: ShaderMaterial;
  private readonly compositeMaterial: ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly source: WebGLRenderTarget;
  private readonly rays: WebGLRenderTarget;

  /** Set by `Stage`: the scene depth, and the camera's clip planes. */
  depth: Texture | null = null;

  private readonly starUv = new Vector2(0.5, 0.5);
  private starWeight = 0;
  /** Per event light: `x,y` screen uv, `z` linear depth 0..1, `w` weight. */
  private readonly events: Vector4[] = [];
  private readonly eventColours: Vector3[] = [];
  private eventCount = 0;

  private lights: { star: Object3D | null; points: PointLight[] } = { star: null, points: [] };
  private scanCountdown = 0;

  private readonly work = new Vector3();

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
    this.source = new WebGLRenderTarget(width, height, options);
    this.rays = new WebGLRenderTarget(width, height, options);

    for (let i = 0; i < 4; i++) {
      this.events.push(new Vector4());
      this.eventColours.push(new Vector3());
    }

    const vertexShader = /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    /**
     * Extract: the frame reduced to "what may emit a shaft", plus the linear
     * depth the event march needs, packed into the alpha the colour is not
     * using. One buffer instead of two, and the march then touches exactly one
     * texture — which is the whole reason it is cheap enough to loop over.
     */
    this.extractMaterial = new ShaderMaterial({
      name: "GodRayPass.extract",
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uNear: { value: 0.1 },
        uFar: { value: 2000 },
        uThreshold: { value: this.threshold },
        uOccluder: { value: new Vector2(this.occluderNear, this.occluderFar) },
      },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform float uNear;
        uniform float uFar;
        uniform float uThreshold;
        uniform vec2 uOccluder;
        varying vec2 vUv;

        float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

        void main() {
          float d = texture2D(tDepth, vUv).x;

          // Depth in world units, not in the buffer's own crushed units. A
          // perspective depth buffer puts everything past ~50 units into its
          // last thousandth, so every comparison this pass makes has to be in
          // view space or it is comparing noise.
          float ndc = d * 2.0 - 1.0;
          float view = 2.0 * uNear * uFar / (uFar + uNear - ndc * (uFar - uNear));

          float mask = smoothstep(uOccluder.x, uOccluder.y, view);

          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float l = luma(c);
          // Soft knee rather than a step, so a body brightening into range
          // eases into raying instead of switching on.
          float keep = max(0.0, l - uThreshold) / max(l, 1e-4);

          gl_FragColor = vec4(c * keep * mask, clamp(view / uFar, 0.0, 1.0));
        }
      `,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    });

    this.marchMaterial = new ShaderMaterial({
      name: "GodRayPass.march",
      defines: { STAR_SAMPLES: 32, EVENT_SAMPLES: 12, MAX_EVENTS: 4 },
      uniforms: {
        tSource: { value: null },
        uStar: { value: new Vector2(0.5, 0.5) },
        uStarWeight: { value: 0 },
        uDensity: { value: this.density },
        uDecay: { value: this.decay },
        uStrength: { value: this.strength },
        uEvents: { value: this.events },
        uEventColours: { value: this.eventColours },
        uEventStrength: { value: this.eventStrength },
        uEventFalloff: { value: this.eventFalloff },
        uEventCount: { value: 0 },
        uAspect: { value: 1 },
      },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSource;
        uniform vec2 uStar;
        uniform float uStarWeight;
        uniform float uDensity;
        uniform float uDecay;
        uniform float uStrength;
        uniform vec4 uEvents[MAX_EVENTS];
        uniform vec3 uEventColours[MAX_EVENTS];
        uniform float uEventStrength;
        uniform float uEventFalloff;
        uniform int uEventCount;
        uniform float uAspect;
        varying vec2 vUv;

        // Cheap spatial hash for the march offset. Spatial only, never
        // animated, for the same reason ToneMapPass's dither is: a moving
        // noise is film grain, and it would crawl under the phosphor.
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
          vec3 acc = vec3(0.0);
          float jitter = hash(gl_FragCoord.xy);

          // The star. A plain radial blur away from its screen position,
          // weighted so the samples nearest this pixel count most — which is
          // what makes the result read as light streaming *past* the frame
          // rather than as a glow pasted over the source.
          if (uStarWeight > 0.0) {
            vec2 delta = (vUv - uStar) * (uDensity / float(STAR_SAMPLES));
            vec2 p = vUv - delta * jitter;
            float weight = 1.0;
            float total = 0.0;
            for (int i = 0; i < STAR_SAMPLES; i++) {
              p -= delta;
              acc += texture2D(tSource, p).rgb * weight;
              total += weight;
              weight *= uDecay;
            }
            // Normalised by the weights actually used, not by the sample
            // count: decay and SAMPLES would otherwise both move the overall
            // brightness, and strength would stop meaning anything on its
            // own. Divided this way it reads as "the fraction of the source's
            // own light the shaft carries", which is a number a person can
            // hold an opinion about.
            acc *= uStrength * uStarWeight / max(total, 1e-4);
          }

          // The event lights. A uniform branch — every pixel in the frame
          // takes it together — so the whole term costs nothing on a frame
          // with nothing exploding, which is most of them.
          if (uEventCount > 0) {
            for (int e = 0; e < MAX_EVENTS; e++) {
              vec4 ev = uEvents[e];
              if (ev.w <= 0.0) continue;

              // Screen distance corrected for aspect, or the falloff is an
              // ellipse and a detonation to the side of the frame reaches
              // further than one above it.
              vec2 offset = (vUv - ev.xy) * vec2(uAspect, 1.0);
              float near = exp(-dot(offset, offset) / max(1e-4, uEventFalloff * uEventFalloff));
              if (near < 0.004) continue;

              vec2 delta = (vUv - ev.xy) * (uDensity / float(EVENT_SAMPLES));
              vec2 p = vUv - delta * jitter;
              float weight = 1.0;
              float lit = 0.0;
              float total = 0.0;
              for (int i = 0; i < EVENT_SAMPLES; i++) {
                p -= delta;
                // Lit if whatever is drawn here stands *behind* the light.
                // The 0.98 is slack for the light sitting inside its own
                // detonation geometry, which would otherwise shadow itself.
                float sceneDepth = texture2D(tSource, p).a;
                lit += step(ev.z * 0.98, sceneDepth) * weight;
                total += weight;
                weight *= uDecay;
              }
              acc += uEventColours[e] * (lit / max(total, 1e-4)) * near * ev.w * uEventStrength;
            }
          }

          gl_FragColor = vec4(acc, 1.0);
        }
      `,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    });

    /**
     * Composite. Additive into the read buffer with no swap — the same
     * arrangement `BloomPass` uses and for the same reason: one full-
     * resolution write with no matching read is cheaper than a full copy.
     */
    this.compositeMaterial = new ShaderMaterial({
      name: "GodRayPass.composite",
      uniforms: { tRays: { value: null } },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D tRays;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(texture2D(tRays, vUv).rgb, 1.0);
        }
      `,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });

    this.quad = new FullScreenQuad(this.extractMaterial);
    this.needsSwap = false;
  }

  /**
   * Find the frame's lights and put them on screen.
   *
   * The scene is scanned for them rather than being told about them, which is
   * a deliberate inversion of the usual arrangement. `main.ts` owns the star
   * (`planLight` → a `DirectionalLight`) and the flash pool (`EventLights`),
   * and a `setLight()` call from there would be one more thing that file has
   * to remember to keep in step — for a pass whose entire input is "which
   * lights are in this scene", which the scene already knows. The scan is
   * cached and refreshed on a slow counter because the answer changes at boot
   * and essentially never again: `EventLights` is explicit that its pool is
   * allocated once and idle lights are driven to zero intensity rather than
   * removed, precisely so the light *count* never changes mid-run.
   */
  aim(scene: Scene, camera: PerspectiveCamera): void {
    if (this.scanCountdown <= 0) {
      this.scan(scene);
      this.scanCountdown = 120;
    }
    this.scanCountdown--;

    this.starWeight = 0;
    this.eventCount = 0;
    for (const e of this.events) e.set(0, 0, 0, 0);

    const star = this.lights.star;
    if (star !== null) {
      // The star is 20000 units out and the far plane is 2000, so it cannot be
      // projected where it stands. Only its *direction* matters — that is the
      // point of putting it that far away in the first place (`STAR.distance`)
      // — so a proxy is placed along that direction at a distance that is
      // certainly inside the frustum.
      this.work.copy(star.position).normalize().multiplyScalar(500).add(camera.position);
      const uv = this.project(this.work, camera);
      if (uv !== null) {
        // Fade as the source leaves the frame: past the edge the ray
        // directions across the screen become near-parallel and the effect
        // stops being radial, so it is faded out rather than allowed to
        // degenerate into a directional smear.
        const radius = Math.max(Math.abs(uv.x * 2 - 1), Math.abs(uv.y * 2 - 1));
        this.starWeight = 1 - smoothstep(0.9, 1.8, radius);
        this.starUv.copy(uv);
      }
    }

    const limit = Math.min(this.eventLights, this.events.length);
    for (const light of this.lights.points) {
      if (this.eventCount >= limit) break;
      if (light.intensity <= 0) continue;

      light.getWorldPosition(this.work);
      const view = -_view.copy(this.work).applyMatrix4(camera.matrixWorldInverse).z;
      const uv = this.project(this.work, camera);
      if (uv === null) continue;

      const slot = this.eventCount++;
      // `EventLights` states its own contract: a caller's `intensity` is in
      // units of the star's, understood as the irradiance at
      // `EVENT_LIGHT.reference` units. Undoing that here rather than
      // re-deriving it means the two files cannot drift.
      const relative = light.intensity / (EVENT_LIGHT.reference * EVENT_LIGHT.reference);
      this.events[slot].set(uv.x, uv.y, view / camera.far, Math.min(1, relative));
      this.eventColours[slot].set(light.color.r, light.color.g, light.color.b);
    }
  }

  private scan(scene: Scene): void {
    const points: PointLight[] = [];
    let star: Object3D | null = null;
    scene.traverse((object) => {
      const candidate = object as Object3D & { isDirectionalLight?: boolean; isPointLight?: boolean };
      if (candidate.isDirectionalLight === true && star === null) star = object;
      else if (candidate.isPointLight === true) points.push(object as PointLight);
    });
    this.lights = { star, points };
  }

  /** World point to screen uv, or `null` if it is behind the camera. */
  private project(point: Vector3, camera: Camera): Vector2 | null {
    const view = _projected.copy(point).applyMatrix4(camera.matrixWorldInverse);
    if (view.z > -1e-3) return null;
    view.applyMatrix4((camera as PerspectiveCamera).projectionMatrix);
    return _uv.set(view.x * 0.5 + 0.5, view.y * 0.5 + 0.5);
  }

  /** Camera clip planes, for the depth linearisation. Set by `Stage`. */
  setClip(near: number, far: number): void {
    this.extractMaterial.uniforms.uNear.value = near;
    this.extractMaterial.uniforms.uFar.value = far;
  }

  override render(
    renderer: WebGLRenderer,
    _writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    if (this.depth === null) return;
    if (this.starWeight <= 0 && this.eventCount === 0) return;

    this.extractMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.extractMaterial.uniforms.tDepth.value = this.depth;
    this.extractMaterial.uniforms.uThreshold.value = this.threshold;
    this.extractMaterial.uniforms.uOccluder.value.set(this.occluderNear, this.occluderFar);
    this.quad.material = this.extractMaterial;
    renderer.setRenderTarget(this.source);
    renderer.clear();
    this.quad.render(renderer);

    const m = this.marchMaterial.uniforms;
    m.tSource.value = this.source.texture;
    m.uStar.value.copy(this.starUv);
    m.uStarWeight.value = this.starWeight;
    m.uDensity.value = this.density;
    m.uDecay.value = this.decay;
    m.uStrength.value = this.strength;
    m.uEventStrength.value = this.eventStrength;
    m.uEventFalloff.value = this.eventFalloff;
    m.uEventCount.value = this.eventCount;
    this.quad.material = this.marchMaterial;
    renderer.setRenderTarget(this.rays);
    renderer.clear();
    this.quad.render(renderer);

    this.compositeMaterial.uniforms.tRays.value = this.rays.texture;
    this.quad.material = this.compositeMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.quad.render(renderer);
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / this.divisor));
    const h = Math.max(1, Math.floor(height / this.divisor));
    this.source.setSize(w, h);
    this.rays.setSize(w, h);
    this.marchMaterial.uniforms.uAspect.value = width / Math.max(1, height);
  }

  override dispose(): void {
    this.source.dispose();
    this.rays.dispose();
    this.extractMaterial.dispose();
    this.marchMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quad.dispose();
  }
}

const _projected = new Vector3();
const _view = new Vector3();
const _uv = new Vector2();

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
