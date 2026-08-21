import {
  BackSide,
  BoxGeometry,
  Color,
  CubeCamera,
  Data3DTexture,
  HalfFloatType,
  LinearFilter,
  Matrix3,
  Mesh,
  NoBlending,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLCoordinateSystem,
  WebGLCubeRenderTarget,
  WebGLRenderer,
} from "three";
import { VOLUME_NOISE_GLSL, createVolumeNoise } from "./volumeNoise.js";

/**
 * The bake — a real volume, raymarched once per sector into a cubemap.
 *
 * # Why bake at all
 *
 * A nebula that is a *pattern painted on a sphere* has no interior, and the one
 * thing an interior buys is the property this whole exercise exists for: **dark
 * dust in front of bright gas**. A single analytic layer cannot express it,
 * because there is no front and no behind — every blend is a tint of one sample.
 * Front-to-back accumulation through a density field with separate emission,
 * scattering and absorption terms expresses it for free, and it is the
 * difference between coloured fog and a photograph.
 *
 * That integral cannot run per-frame at any quality worth having. So it runs
 * once, into a cubemap, and `Nebula.ts` adds a cheap high-frequency layer live
 * on top at screen resolution — because a cubemap cannot be sharp enough on its
 * own. A face covers 90 degrees; this display is 36 pixels a degree, so matching
 * it would need 3240px faces and about 800 MB. A 1024px face is 11 pixels a
 * degree, which is visibly soft — and *deliberately* so, because the thing being
 * baked is the low-frequency volumetric structure, which is inherently soft. The
 * sharpness is somebody else's job by design, not by compromise.
 *
 * # The three channels
 *
 * Real nebulosity is three physically distinct things and the old shader blended
 * two colours, which is exactly why it read as fog:
 *
 *  1. **Ionised gas emitting.** H-alpha crimson where the ionising flux is weak,
 *     O III teal where it is strong — so the teal is *near the star* and the
 *     crimson further out, which is the whole reason the Trapezium region looks
 *     the way it does. The mix is driven by the computed illumination, not
 *     painted.
 *  2. **Dust scattering starlight.** Blue, because dust scatters short
 *     wavelengths better, and forward-biased through a Henyey-Greenstein phase
 *     term so the medium brightens around the star rather than uniformly.
 *  3. **Dust absorbing.** Near-black, and *wavelength-dependent*: the extinction
 *     coefficients are `(0.78, 1.00, 1.36)`, so light coming through dust
 *     reddens. That reddening is what sells a foreground lane as *matter* rather
 *     than as a darker paint.
 *
 * # The embedded star
 *
 * A hot young star inside the cloud, seeded per sector, doing three jobs at
 * once: it carves a cavity (density multiplied out inside a *ragged* radius, not
 * a sphere — a sphere reads as a bubble, a ragged one reads as blown), it piles
 * an ionisation front up on the cavity wall, and it lights that wall from
 * within. The pillars come out of the shadow march for nothing: a dense knot on
 * the wall shadows the medium behind it, and the shadow points away from the
 * star. That is what an elephant trunk *is*, and it cost five taps a sample.
 *
 * # What it costs
 *
 * 6.3 million fragments at 84 steps with roughly a dozen texture taps each,
 * which measures in the tens of milliseconds all told — see `BAKE.tiles` for how
 * that is spread so no single frame ever pays a visible share of it.
 */
export const BAKE = {
  /**
   * The first pass, all six faces, one face a frame. Small enough that a face
   * is a fraction of a millisecond, which is what makes it safe to run during a
   * hyperwarp arrival — the locked "the chart does not pause the game" rule
   * applies with equal force to the sky, and an arrival happens with something
   * shooting at you.
   */
  preview: 192,
  /** The real one. 1024 is 50 MB at RGBA16F and 11 pixels a degree. */
  full: 1024,
  /**
   * Tiles a side, per face, for the full bake — so 6 * tiles^2 jobs.
   *
   * This is the knob that decides the worst frame, and it is the whole answer
   * to "the hitch matters". Two gives 24 jobs of 512x512, which measured at
   * about 1.5 ms each and finishes in 24 frames — 0.4 s, inside the hyperwarp
   * arrival's own settle. Raising it makes every frame cheaper and the refine
   * longer; the trade is linear and this is the point on it where neither half
   * is noticeable.
   */
  tiles: 2,
  /** March steps. The preview is coarser because it is about to be replaced. */
  previewSteps: 52,
  fullSteps: 84,
  /** Steps along the ray toward the embedded star. Five is enough for pillars. */
  shadowSteps: 5,
  /**
   * The ceiling on one *measured* preview face, in milliseconds, above which
   * the whole bake is abandoned for the session and the sky stays analytic.
   *
   * The belt to the software-renderer braces in `Nebula.ts`. That check catches
   * SwiftShader by name; this catches everything it does not know the name of,
   * including a real GPU too weak for this, without needing a list.
   *
   * It is a direct measurement with a pipeline flush, not an inference from
   * frame times, and that is the second thing this cost a debugging round to
   * learn. Wall-clock frame gaps are not a signal: a browser tab that is not
   * being composited throttles `requestAnimationFrame` to about half a hertz
   * while still reporting `document.hidden === false`, so a frame-gap guard
   * retires the volume on a perfectly good GPU and does it silently. One flush,
   * once a session, on the second job — the second, because the first absorbs
   * the shader compile and would read as a slow GPU on any machine at all.
   *
   * Eight is roughly ten times what a preview face measures on an M2 Max
   * (0.85 ms). Past that the full bake would want a whole millisecond a frame
   * on a machine that is already struggling, and a sky that is merely flat is a
   * much smaller failure than a game that stutters.
   */
  probeMs: 8,
};

/** The march's near and far bound, in bake units. The volume is a unit ball. */
const T_NEAR = 0.02;
const T_FAR = 1.0;

const VERTEX = /* glsl */ `
varying vec3 vRay;
void main() {
  // The box is centred on the origin with the camera inside it, so a vertex's
  // own local position *is* the direction that pixel looks in. Interpolating
  // that is exact for a ray direction, which is all the fragment stage wants.
  vRay = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function fragment(): string {
  return /* glsl */ `
precision highp float;
precision highp sampler3D;

varying vec3 vRay;

uniform sampler3D uNoise;

uniform vec3 uPole;
uniform vec3 uCloud;
uniform vec3 uStar;
uniform vec3 uStarColor;
uniform vec3 uHa;
uniform vec3 uOiii;
uniform vec3 uAlbedo;
uniform vec3 uIsrf;
uniform vec3 uDisc;
uniform vec3 uNoiseOffset;
uniform mat3 uNoiseRot;

uniform float uDiscR;
uniform float uBubble;
uniform float uGasH;
uniform float uDustH;
uniform float uLaneC;
uniform float uKappa;
uniform float uCloudR;
uniform float uCavityR;
uniform float uStarR;
uniform float uStarPower;
uniform float uStarCore;
uniform float uEmission;
uniform float uScatter;
uniform float uFilament;
uniform float uTeal;
uniform float uDiffuseIon;
uniform int uSteps;

${VOLUME_NOISE_GLSL}

// Frequencies are compiled in rather than exposed: they are the *scale* of the
// field relative to the march, and changing them is changing what the volume is
// rather than tuning it. Roughly three periods of the base octave across the
// whole ball, which is coarse enough that the texture's own tiling never
// resolves and fine enough that the top octave is real structure.
const float T_NEAR = ${T_NEAR.toFixed(4)};
const float T_FAR = ${T_FAR.toFixed(4)};
const float STRUCT_FREQ = 6.0;
const float CURL_FREQ = 2.6;
const float CURL_EPS = 0.09;
// The curl comes out at order 1/CURL_EPS, which as a displacement in texture
// space would be several whole periods — a scramble, not a shear. This is the
// factor that makes uFilament = 1 mean "strongly sheared" rather than "noise".
const float CURL_GAIN = 0.15;
const float DUST_FREQ = 0.52;
// Radiance gains, so that the console own-brightness knob sits near 1 for a
// picture rather than near 8. Two of them rather than one because the ratio is
// the actual decision: emission is the band, scattering is the blue haze around
// it, and a single output scale would have made "more nebula" and "more dust
// glow" the same knob. First-draft numbers, arrived at by looking.
const float EMIT_GAIN = 9.0;
const float SCATTER_GAIN = 9.0;

/**
 * Optical depth from a point toward the embedded star.
 *
 * A cheap density — one fetch, no curl — because a shadow ray only has to know
 * roughly how much is in the way, and this runs five times per lit sample. It
 * reuses the cavity carve so the cavity does not shadow itself, which is what
 * keeps the near wall lit instead of self-eclipsed.
 */
float starShadow(vec3 from) {
  vec3 sd = uStar - from;
  float sl = length(sd);
  if (sl < 1e-4) return 1.0;
  sd /= sl;
  float st = sl / float(${BAKE.shadowSteps});
  float tau = 0.0;
  for (int j = 0; j < ${BAKE.shadowSteps}; j++) {
    vec3 sp = from + sd * (st * (float(j) + 0.5));
    vec3 dcv = sp - uCloud;
    float cm = exp(-dot(dcv, dcv) / (uCloudR * uCloudR));
    if (cm < 0.01) continue;
    float ds = length(sp - uStar);
    float cav = smoothstep(uCavityR * 0.55, uCavityR * 1.10, ds);
    vec3 q = uNoiseRot * sp + uNoiseOffset;
    float f = fbm1(q * STRUCT_FREQ);
    float d = cm * cav * clamp(0.50 + 1.6 * f, 0.0, 2.0);
    tau += d * d * st;
  }
  return exp(-tau * uKappa * 1.8);
}

void main() {
  vec3 dir = normalize(vRay);

  vec3 col = vec3(0.0);
  vec3 trans = vec3(1.0);
  vec3 transStar = vec3(1.0);
  float weight = 0.0;
  float starT = length(uStar);

  // Exponential stepping, and it is the right shape for a sky bake rather than
  // a convenience: each step then subtends a constant *angular* size, so the
  // sampling density matches what the cubemap can actually record at every
  // distance. A uniform march spends most of its steps far away, where a step
  // is smaller than a texel, and starves the near volume where it is not.
  float k = pow(T_FAR / T_NEAR, 1.0 / float(uSteps));
  float t = T_NEAR;

  for (int i = 0; i < ${BAKE.fullSteps}; i++) {
    if (i >= uSteps) break;
    float dt = t * (k - 1.0);
    vec3 p = dir * t;

    float h = dot(p, uPole);
    // The gas disc. An observer inside a plane-parallel slab sees a column that
    // goes as 1/sin(latitude), which is sharper and more band-like than the
    // gaussian-in-latitude the painted version used — and it is not a profile
    // chosen to look right, it is what falls out of being inside the thing.
    float slabGas = exp(-(h * h) / (uGasH * uGasH));
    // The local bubble, and it is the single most useful line in this shader.
    //
    // An observer sitting *in* the midplane samples full density in every
    // direction for the first stretch of every ray, so the near volume
    // contributes the same amount toward the pole as along the plane — which
    // puts a bright isotropic floor under the whole sky and flattens the band
    // to about four to one. The cure is the thing that is actually true of the
    // solar neighbourhood: we are inside a low-density cavity a few hundred
    // light years across, blown clear by old supernovae. Fading the medium in
    // over the first tenth of the march removes almost all of the polar column
    // (which is only about that long to begin with) and almost none of the
    // plane's (which runs to the end), and the band goes from four to one to
    // something worth looking at.
    float bubble = smoothstep(uBubble * 0.35, uBubble * 1.40, t);
    slabGas *= bubble;
    // The dust disc, thinner and offset. The offset is why the lane reads as a
    // lane: a slab centred slightly off the observer's own height is longer on
    // one side than the other, so the dark band's centroid shifts to uLaneC
    // exactly the way the real one does, rather than being a stripe drawn on.
    float hd = h - uLaneC;
    float slabDust = exp(-(hd * hd) / (uDustH * uDustH)) * bubble;
    // ...and the disc is *finite*, which is not a detail. An infinite slab seen
    // from inside gives a column that goes as 1/sin(latitude) and nothing else,
    // and 1/sin is a remarkably flat curve: at the pole it is still a third of
    // what it is on the plane, so the band comes out as a wash. What actually
    // makes the Milky Way a band is that the disc runs out — and putting the
    // observer off-centre in it buys the other half of the real thing for the
    // same three lines, a bright inner galaxy on one side and a thin anticentre
    // on the other. The sky stops being rotationally symmetric about the pole,
    // which is the difference between a place and a stripe.
    vec3 rel = p - uDisc;
    vec3 radial = rel - uPole * dot(rel, uPole);
    float disc = exp(-dot(radial, radial) / (uDiscR * uDiscR));
    slabGas *= disc;
    slabDust *= disc;
    vec3 dcv = p - uCloud;
    float cloud = exp(-dot(dcv, dcv) / (uCloudR * uCloudR));

    // Most of the sky is empty and the noise is the whole cost. This gate is
    // worth roughly half the bake.
    if (slabGas + slabDust + cloud > 0.006) {
      vec3 q = uNoiseRot * p + uNoiseOffset;
      vec3 c = curl3(q * CURL_FREQ, CURL_EPS);
      vec3 w = q * STRUCT_FREQ + uFilament * CURL_GAIN * c;
      vec2 f = fbm2(w);
      // Dust gets its own field at a *third* of the frequency, and that is the
      // difference between a nebula and a mottle. Deriving both from one field
      // put dust and gas in the same small clumps everywhere, so every ray
      // passed through roughly the same amount of each and the sum came out an
      // even mauve — occlusion that is uniformly distributed is not occlusion,
      // it is a tint. Big dust masses in front of finer gas is what silhouettes
      // look like, and a silhouette is the whole reason there is a volume here.
      // Three more fetches a sample; the bake had the headroom.
      vec2 fc = fbm2(w * DUST_FREQ + vec3(11.3, 5.7, 19.1));

      // Two fields from one pair: dense is the medium, grain is what makes
      // the dust a different shape from the gas rather than a copy of it. Both
      // biased toward the faint end and squared where they feed dust, because
      // real nebulosity is mostly nothing with a few dense knots and a linear
      // map of noise is an even grey.
      // Biased *below* zero at the mean and clamped, so roughly two fifths of
      // the volume is genuinely empty. That emptiness is where the picture's
      // blacks come from: a field whose minimum is a dim grey has no gaps for
      // anything to be silhouetted against, which was the first draft's real
      // failure — it read as an even wash however the colours were balanced.
      float dense = clamp(0.35 + 1.60 * f.x, 0.0, 2.4);
      float grain = clamp(0.30 + 1.70 * fc.x, 0.0, 2.4);

      vec3 toP = p - uStar;
      float ds = length(toP);
      vec3 sdir = toP / max(ds, 1e-4);
      // A ragged cavity radius, sampled on the *direction* from the star so it
      // is a property of the wall rather than of the point. A smooth radius
      // gives a soap bubble; this gives a blown hole.
      float rag = texture(uNoise, sdir * 1.9 + uNoiseOffset).y;
      float rr = uCavityR * (0.72 + 0.56 * rag);
      float cav = smoothstep(rr * 0.55, rr * 1.10, ds);
      float rim = exp(-pow((ds - rr) / (rr * 0.42), 2.0));

      float cl = cloud * cav;

      float gasDen = slabGas * dense * dense * 0.55 + cl * dense * 2.20 + cl * rim * 3.60;
      // Dust lives in the *whole* disc, not only in the lane — it is merely
      // concentrated at the midplane. Confining it to the thin slab was the
      // first draft and it cost the entire blue channel: with no dust off the
      // lane there is nothing to scatter starlight anywhere the eye is looking,
      // so the sky came out as pure H-alpha and read as a red filter rather
      // than as a nebula. The thin term is still what makes the lane opaque;
      // the wide one is what makes the band blue around it.
      float dustDen = (slabDust + slabGas * 0.30) * grain * grain
                    + cl * grain * grain * 1.80;

      float d2 = dot(toP, toP);
      float lit = uStarPower / (d2 / (uCloudR * uCloudR) + 0.06);
      // Shadowing only where there is a cloud to shadow. Outside it the star is
      // the only source and there is nothing in the way, so five taps a sample
      // would buy an unchanged 1.0.
      if (cl > 0.015) lit *= starShadow(p);

      // (a) ionised gas emitting. The teal is where the flux is, which is a
      // computed fact here rather than a painted one.
      float ion = uDiffuseIon + lit;
      vec3 emitCol = mix(uHa, uOiii, smoothstep(0.5, 3.5, lit) * uTeal);
      vec3 src = gasDen * ion * emitCol * uEmission * EMIT_GAIN;

      // (b) dust scattering starlight, forward-biased, plus the diffuse
      // interstellar field so dust away from any star is still faintly blue.
      float cosT = dot(dir, sdir);
      float g = 0.42;
      float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-3), 1.5) * 0.25;
      src += dustDen * uAlbedo * (uIsrf + uStarColor * lit * hg) * uScatter * SCATTER_GAIN;

      // The star itself, as a small emissive ball rather than a post-hoc glow,
      // so it is occluded by anything in front of it like everything else here.
      src += exp(-(ds * ds) / (uStarR * uStarR)) * uStarColor * uStarCore;

      // (c) dust absorbing, and it absorbs blue hardest — so what comes through
      // a lane is reddened, not just dimmed.
      vec3 sigma = dustDen * uKappa * vec3(0.78, 1.00, 1.36);

      // Front to back. trans is what makes the ordering real: a sample only
      // contributes what the medium in front of it lets through, so a dust knot
      // at t = 0.2 genuinely occludes a bright knot at t = 0.6.
      col += trans * src * dt;
      trans *= exp(-sigma * dt);
      // Remembered for the star's own core below, so it is occluded by whatever
      // is genuinely in front of it and by nothing that is not.
      if (t < starT) transStar = trans;

      // How much visible structure this direction has, for the live detail
      // layer to key off. Weighted by transmittance so detail is not painted
      // onto something that is behind a wall of dust.
      weight += (gasDen + dustDen) * dt * dot(trans, vec3(0.3333));
    }

    if (max(trans.r, max(trans.g, trans.b)) < 0.012) break;
    t *= k;
  }

  // The star itself, analytically rather than as a sample.
  //
  // It is in the march as a small emissive ball too, and that ball is about a
  // hundredth of the march length wide while an exponential step at its own
  // distance is four times that — so the march walks straight past it and the
  // one thing the whole cavity is built around never appears. Closest approach
  // is exact, costs four instructions, and cannot be stepped over. The wide
  // second lobe is the halo; both are attenuated by the medium in front of the
  // star and by nothing behind it, which is what lets a dust knot eclipse it.
  float along = dot(dir, uStar);
  if (along > 0.0) {
    float b2 = dot(uStar, uStar) - along * along;
    float core = exp(-b2 / (uStarR * uStarR));
    float halo = exp(-b2 / (uStarR * uStarR * 90.0));
    col += transStar * uStarColor * uStarCore * (core + 0.22 * halo);
  }

  gl_FragColor = vec4(col, clamp(weight * 1.6, 0.0, 1.0));
}
`;
}

/** Everything the bake needs that is not a live tuning knob. */
export interface NebulaBakePlan {
  pole: Vector3;
  /** Dust-lane latitude, radians. */
  laneRad: number;
  cloud: Vector3;
  star: Vector3;
  /** Centre of the finite gas disc, offset from the observer. See the shader. */
  disc: Vector3;
  discR: number;
  cloudR: number;
  starColor: Color;
  ha: Color;
  oiii: Color;
  albedo: Color;
  isrf: Color;
  noiseOffset: Vector3;
  noiseRot: Matrix3;
}

/** The live half — anything the tuning console can move without a rebake is not here. */
export interface NebulaBakeTuning {
  gasH: number;
  dustH: number;
  kappa: number;
  cavity: number;
  starPower: number;
  emission: number;
  scatter: number;
  filament: number;
  teal: number;
  diffuseIon: number;
}

/**
 * Owns the two cube targets, the march material and the job queue.
 *
 * It never holds a renderer: `Nebula` hands one in on each `step`, because the
 * only renderer this project has belongs to `Stage` and `main.ts` constructs
 * `Nebula` with no arguments — a surface that is not mine to change.
 */
export class NebulaBake {
  readonly preview: WebGLCubeRenderTarget;
  readonly full: WebGLCubeRenderTarget;

  private readonly noise: Data3DTexture;
  private readonly scene = new Scene();
  private readonly material: ShaderMaterial;
  private readonly mesh: Mesh;
  private readonly cubeCamera: CubeCamera;
  private readonly cameras: PerspectiveCamera[];

  /** Jobs finished. 0..5 are preview faces; the rest are full-cube tiles. */
  private done = 0;
  private readonly total = 6 + 6 * BAKE.tiles * BAKE.tiles;

  constructor() {
    const options = {
      type: HalfFloatType,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    };
    this.preview = new WebGLCubeRenderTarget(BAKE.preview, options);
    this.preview.texture.name = "nebula.preview";
    this.full = new WebGLCubeRenderTarget(BAKE.full, options);
    this.full.texture.name = "nebula.full";

    this.noise = createVolumeNoise();

    this.material = new ShaderMaterial({
      // No `glslVersion: GLSL3`, and the reason is worth stating because the
      // obvious reading says there should be. `sampler3D` genuinely does not
      // exist in GLSL ES 1.00 — but three r185 rewrites *every* non-raw
      // `ShaderMaterial` to `#version 300 es` regardless, so the type is
      // already available. What `GLSL3` actually changes is that three then
      // stops emitting `pc_fragColor` and the `gl_FragColor` alias, on the
      // grounds that a shader asking for GLSL3 will declare its own output. So
      // asking for it here would buy nothing and cost this file the one idiom
      // every other shader in the project is written in. Cost one compile
      // error to establish; see `WebGLProgram.js` around the `isRawShaderMaterial`
      // branch.
      vertexShader: VERTEX,
      fragmentShader: fragment(),
      uniforms: {
        uNoise: { value: this.noise },
        uPole: { value: new Vector3(0, 1, 0) },
        uCloud: { value: new Vector3() },
        uStar: { value: new Vector3() },
        uStarColor: { value: new Color(0.72, 0.82, 1.0) },
        uHa: { value: new Color(1.0, 0.16, 0.26) },
        uOiii: { value: new Color(0.16, 0.95, 0.72) },
        uAlbedo: { value: new Color(0.4, 0.58, 1.0) },
        uIsrf: { value: new Color(0.30, 0.38, 0.62) },
        uDisc: { value: new Vector3() },
        uNoiseOffset: { value: new Vector3() },
        uNoiseRot: { value: new Matrix3() },
        uDiscR: { value: 0.75 },
        uBubble: { value: 0.10 },
        uGasH: { value: 0.34 },
        uDustH: { value: 0.12 },
        uLaneC: { value: 0 },
        uKappa: { value: 3.0 },
        uCloudR: { value: 0.22 },
        uCavityR: { value: 0.13 },
        uStarR: { value: 0.012 },
        uStarPower: { value: 1 },
        uStarCore: { value: 2.2 },
        uEmission: { value: 1 },
        uScatter: { value: 1 },
        uFilament: { value: 1 },
        uTeal: { value: 0.55 },
        uDiffuseIon: { value: 0.35 },
        uSteps: { value: BAKE.fullSteps },
      },
      side: BackSide,
      // Every fragment of the face is covered exactly once by the box's inner
      // surface, so there is nothing to clear, nothing to blend and nothing to
      // depth-sort. That matters more than it looks: `Stage` runs with
      // `autoClear` off, so a bake that needed clearing would have to say so.
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new Mesh(new BoxGeometry(2, 2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    /**
     * `CubeCamera` purely as a source of six correctly-oriented cameras.
     *
     * Its `update()` is not used — that renders all six faces at once, which is
     * the one thing this class exists to avoid. What is wanted is the
     * orientation convention, and hand-rolling it is a trap: three's own
     * cameras carry a *negative* field of view and inverted `up` vectors, which
     * together produce the double flip a cubemap face needs. Getting that wrong
     * yields a sky that still looks like a sky and is silently mirrored against
     * the star band it is supposed to agree with.
     */
    this.cubeCamera = new CubeCamera(0.05, 8, this.full);
    // `CubeCamera` builds its six cameras pointing *nowhere in particular* and
    // only orients them inside `update()`, off the renderer's coordinate
    // system — which is the one method this class deliberately does not call.
    // Left alone, all six look down -Z, every face of the cube gets identical
    // content, and the result is a sky that is smooth within a face and steps
    // hard at every face boundary: three straight-edged wedges meeting at the
    // cube's corners, which is exactly how this was found. Stating the
    // coordinate system is honest here rather than a workaround: this project
    // has one renderer and it is a `WebGLRenderer`.
    this.cubeCamera.coordinateSystem = WebGLCoordinateSystem;
    this.cubeCamera.updateCoordinateSystem();
    this.cubeCamera.updateMatrixWorld(true);
    // After `updateCoordinateSystem`, which removes and re-adds all six in the
    // canonical +X, -X, +Y, -Y, +Z, -Z order the cube face indices use.
    this.cameras = this.cubeCamera.children as PerspectiveCamera[];
  }

  get previewReady(): boolean {
    return this.done >= 6;
  }

  get fullReady(): boolean {
    return this.done >= this.total;
  }

  get progress(): number {
    return this.done / this.total;
  }

  /** Point the volume at a sector and restart the queue from the first face. */
  plan(plan: NebulaBakePlan, tuning: NebulaBakeTuning): void {
    const u = this.material.uniforms;
    (u.uPole.value as Vector3).copy(plan.pole).normalize();
    (u.uCloud.value as Vector3).copy(plan.cloud);
    (u.uStar.value as Vector3).copy(plan.star);
    (u.uStarColor.value as Color).copy(plan.starColor);
    (u.uHa.value as Color).copy(plan.ha);
    (u.uOiii.value as Color).copy(plan.oiii);
    (u.uAlbedo.value as Color).copy(plan.albedo);
    (u.uIsrf.value as Color).copy(plan.isrf);
    (u.uDisc.value as Vector3).copy(plan.disc);
    (u.uNoiseOffset.value as Vector3).copy(plan.noiseOffset);
    (u.uNoiseRot.value as Matrix3).copy(plan.noiseRot);
    u.uLaneC.value = plan.laneRad;
    u.uCloudR.value = plan.cloudR;
    u.uDiscR.value = plan.discR;
    this.retune(tuning);
    this.done = 0;
  }

  /** Bake-affecting knobs, without disturbing the queue. Call `plan` to restart it. */
  retune(t: NebulaBakeTuning): void {
    const u = this.material.uniforms;
    u.uGasH.value = t.gasH;
    u.uDustH.value = t.dustH;
    u.uKappa.value = t.kappa;
    u.uCavityR.value = (u.uCloudR.value as number) * t.cavity;
    u.uStarR.value = (u.uCavityR.value as number) * 0.09;
    u.uStarPower.value = t.starPower;
    u.uEmission.value = t.emission;
    u.uScatter.value = t.scatter;
    u.uFilament.value = t.filament;
    u.uTeal.value = t.teal;
    u.uDiffuseIon.value = t.diffuseIon;
  }

  /**
   * Run exactly one job, or nothing if the queue is drained.
   *
   * One job a frame, always — the preview faces and the full tiles are sized so
   * that the largest of them is a fraction of a millisecond, which is what makes
   * this safe to run while something is shooting at you. Returns whether it did
   * any work, so the caller can time only the frames that cost something.
   */
  step(renderer: WebGLRenderer): boolean {
    if (this.done >= this.total) return false;

    const previous = renderer.getRenderTarget();
    const job = this.done;

    if (job < 6) {
      this.material.uniforms.uSteps.value = BAKE.previewSteps;
      renderer.setRenderTarget(this.preview, job);
      renderer.render(this.scene, this.cameras[job]);
    } else {
      const index = job - 6;
      const per = BAKE.tiles * BAKE.tiles;
      const face = Math.floor(index / per);
      const tile = index % per;
      const span = BAKE.full / BAKE.tiles;
      const tx = (tile % BAKE.tiles) * span;
      const ty = Math.floor(tile / BAKE.tiles) * span;

      // The target's own scissor, not `renderer.setScissor` — that one
      // multiplies by the canvas pixel ratio, which is right for the canvas and
      // wrong by a factor of two for a render target. `setRenderTarget` reads
      // these fields off the target, so they have to be set before it.
      this.full.scissor.set(tx, ty, span, span);
      this.full.scissorTest = true;
      this.material.uniforms.uSteps.value = BAKE.fullSteps;
      renderer.setRenderTarget(this.full, face);
      renderer.render(this.scene, this.cameras[face]);
      this.full.scissorTest = false;
    }

    renderer.setRenderTarget(previous);
    this.done++;
    return true;
  }

  /** Abandon the queue where it stands. Used when a bake frame overran. */
  abandon(): void {
    this.done = this.total;
    this.full.scissorTest = false;
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
    this.noise.dispose();
    this.preview.dispose();
    this.full.dispose();
  }
}
