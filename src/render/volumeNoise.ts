import {
  Data3DTexture,
  LinearFilter,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
} from "three";

/**
 * The volume bench — a tileable 3D noise field, and the GLSL that reads it.
 *
 * **Why a texture and not `render/shaders/noise.ts`.** That ladder is the right
 * answer for a *surface*: one `flow()` per fragment, evaluated once, on a body
 * that covers a third of the frame. A volume evaluates the field once per
 * *march step*, and the nebula bake takes ~84 of them through ~6.3 million
 * fragments — four hundred million evaluations for one cubemap. At the measured
 * throughput of that ladder (the shipped 5-octave sky nebula is roughly 700
 * million `hash31` calls a frame inside a 4.19 ms budget, so call it 45 billion
 * `noise3` a second) a single analytic `flow()` per sample would put the bake
 * somewhere north of thirty seconds. A trilinear `sampler3D` fetch is hardware,
 * the whole field is 1 MB and therefore lives in cache, and the same bake lands
 * in well under a tenth of a second. That is the entire reason this file exists.
 *
 * **Why it is built on the CPU, once, and is seed-independent.** Two things had
 * to be true at the same time: the bake must be deterministic per campaign seed
 * and sector, and it must not cost a per-sector hitch to regenerate a volume.
 * Both hold if the *field* is a fixed, tileable block of noise and the *seed*
 * only chooses where and how the march samples it — a seeded rotation and
 * offset of the sampling coordinates. Two sectors then draw genuinely different
 * clouds out of one megabyte, at no per-sector cost at all, and the same
 * (seed, sector) always lands on the same rotation.
 *
 * The alternative considered and rejected was generating this on the GPU into a
 * `WebGL3DRenderTarget`, layer by layer. It would be about a hundred times
 * faster to build and it needs a renderer, which this module is constructed
 * without — and the failure mode of getting the layered-target path wrong is a
 * silently black field and therefore an invisible nebula, several layers away
 * from the cause. A one-time ~40 ms on the CPU during page setup, before the
 * first frame has been asked for, buys certainty for a cost nobody can see.
 *
 * **Why it tiles.** `RepeatWrapping` on all three axes means the shader may
 * sample the same texture at 1x, 2x and 4x and get three seamless octaves out
 * of one block. Non-integer octave scales are deliberate: they keep the octaves
 * from sharing a period and turning the repeat into a visible lattice.
 */
export const VOLUME_NOISE = {
  /** Voxels on a side. 64 is 1 MB at RGBA8 and fits comfortably in L2. */
  size: 64,
  /**
   * Lattice cells across the block, and therefore the base frequency.
   *
   * Six is the compromise the octave count forces. The shader builds its fBm by
   * sampling this at 1x, 2x and 4x, so the top octave sees 24 cells across 64
   * voxels — under three voxels a cell, which is the point where trilinear
   * interpolation stops looking like noise and starts looking like a grid. Any
   * higher base and the third octave breaks; any lower and the largest features
   * are bigger than the volume the march walks through.
   */
  cells: 6,
  /**
   * Four decorrelated fields, one per channel. Not four octaves — the shader
   * makes octaves by rescaling. These exist so the density field, the dust
   * field, the curl potential and the cavity's own raggedness can each be a
   * different shape without any of them costing an extra fetch: three fetches
   * at three scales yield twelve numbers, and two independent fBms come out of
   * the same three fetches. That trick is what keeps the per-sample cost down.
   */
  channels: 4,
};

/**
 * A periodic value-noise lattice, `cells^3` random values, wrapping on every
 * axis. Its own linear congruential stream rather than a shared `makeRng`,
 * because this is a fixed asset built once at construction — nothing here is
 * seeded by a campaign and nothing about it should ever change between runs.
 */
function lattice(cells: number, seed: number): Float32Array {
  const out = new Float32Array(cells * cells * cells);
  let s = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s / 4294967296;
  }
  return out;
}

/**
 * Build the field. ~40 ms on an M2 Max, once, at module construction.
 *
 * The inner loop is table lookups rather than arithmetic on purpose: the
 * smoothstep weight and the two lattice indices for a given voxel coordinate
 * depend only on that one axis, so all three axes are precomputed into arrays
 * of length `size` and the triple loop degenerates to eight reads and seven
 * lerps a voxel. Computing the weights inline instead measured about four times
 * slower and would have put this into "visible boot hitch" territory.
 */
export function createVolumeNoise(): Data3DTexture {
  const { size, cells, channels } = VOLUME_NOISE;
  const data = new Uint8Array(size * size * size * 4);

  const i0 = new Int32Array(size);
  const i1 = new Int32Array(size);
  const w = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const f = (x * cells) / size;
    const c = Math.floor(f);
    const t = f - c;
    i0[x] = ((c % cells) + cells) % cells;
    i1[x] = (i0[x] + 1) % cells;
    // Smoothstep rather than linear: a linear value noise has visible creases
    // along every lattice plane, and a volume shows them from the inside.
    w[x] = t * t * (3 - 2 * t);
  }

  for (let ch = 0; ch < channels; ch++) {
    // Each channel is its own lattice, so the four fields are genuinely
    // independent rather than four projections of one.
    const L = lattice(cells, 0x9e3779b1 + ch * 0x85ebca6b);
    for (let z = 0; z < size; z++) {
      const z0 = i0[z] * cells * cells;
      const z1 = i1[z] * cells * cells;
      const wz = w[z];
      for (let y = 0; y < size; y++) {
        const y0 = i0[y] * cells;
        const y1 = i1[y] * cells;
        const wy = w[y];
        const row = (z * size + y) * size;
        for (let x = 0; x < size; x++) {
          const x0 = i0[x];
          const x1 = i1[x];
          const wx = w[x];
          const n000 = L[z0 + y0 + x0];
          const n100 = L[z0 + y0 + x1];
          const n010 = L[z0 + y1 + x0];
          const n110 = L[z0 + y1 + x1];
          const n001 = L[z1 + y0 + x0];
          const n101 = L[z1 + y0 + x1];
          const n011 = L[z1 + y1 + x0];
          const n111 = L[z1 + y1 + x1];
          const a = n000 + (n100 - n000) * wx;
          const b = n010 + (n110 - n010) * wx;
          const c = n001 + (n101 - n001) * wx;
          const d = n011 + (n111 - n011) * wx;
          const e = a + (b - a) * wy;
          const f = c + (d - c) * wy;
          data[(row + x) * 4 + ch] = (e + (f - e) * wz) * 255;
        }
      }
    }
  }

  const texture = new Data3DTexture(data, size, size, size);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  // All three axes, because the shader relies on rescaling to make octaves and
  // an unwrapped axis would clamp the top octave into a smear at the faces.
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.wrapR = RepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = "nebula.volumeNoise";
  return texture;
}

/**
 * The one field, shared by every consumer that does not own its own.
 *
 * `createVolumeNoise()` above stays exactly what it was — a factory that hands
 * back a fresh texture the caller owns and disposes — because that is the
 * contract `NebulaBake` was written against and it *does* dispose its copy
 * (`NebulaBake.dispose`). Quietly turning the factory into a cache would have
 * made one consumer's teardown blank another's field, several layers from the
 * cause, which is the same class of silently-black failure that file's own
 * header records talking it out of the GPU bake path.
 *
 * So the sharing is a second, additive entrance rather than a change to the
 * first. What comes back is a **module-lifetime asset with no `dispose`**: the
 * volumetric media (`render/shaders/media.ts`) build and tear down a material
 * per comet and per sector, and a texture whose lifetime followed the material
 * would pay the ~40 ms build again on every sector change. One megabyte held
 * for the session is the right trade against a hitch a player can see.
 *
 * Built lazily, at the first march compiled rather than at import: a machine
 * where `mediaQuality()` returns 0 — the headless software-GL harness — builds
 * no volume at all, and should not spend 40 ms of CPU on a field nothing will
 * ever sample.
 */
let shared: Data3DTexture | null = null;
export function sharedVolumeNoise(): Data3DTexture {
  if (!shared) {
    shared = createVolumeNoise();
    shared.name = "shared.volumeNoise";
  }
  return shared;
}

/**
 * The two lines a consuming shader needs in front of the rungs below.
 *
 * A constant rather than a comment telling each caller to type it, because
 * getting it wrong is a compile error several layers from the cause: GLSL ES
 * 3.00 gives `sampler3D` no default precision in a fragment shader, so a
 * missing `precision highp sampler3D;` fails the *whole* program and surfaces
 * as an invisible body with a console warning.
 */
export const VOLUME_NOISE_DECL = /* glsl */ `
precision highp sampler3D;
uniform sampler3D uNoise;
`;

/**
 * The GLSL rungs that read it. Requires `uniform sampler3D uNoise;` and a
 * `precision highp sampler3D;` declaration in the consuming shader, and
 * therefore requires that shader to be `GLSL3` — `sampler3D` does not exist in
 * GLSL ES 1.00, which is what a WebGL2 context still compiles a `ShaderMaterial`
 * as unless it asks otherwise.
 *
 * Nothing here reads a uniform other than `uNoise`, for the same reason
 * `render/shaders/noise.ts` reads none at all: every knob is an argument, so a
 * second consumer with a different uniform vocabulary can take these rungs
 * unchanged.
 */
export const VOLUME_NOISE_GLSL = /* glsl */ `
// Two decorrelated fractal fields for the price of three fetches.
//
// Three samples at three scales give twelve channels; the two fBms are built
// from disjoint sets of them, so x and y are independent fields with
// matching statistics rather than one field and a copy. The offsets stop the
// octaves from lining up at the origin, which is otherwise a visible knot at
// the exact centre of the volume.
vec2 fbm2(vec3 p) {
  vec4 a = texture(uNoise, p * 1.000 + vec3(0.13, 0.71, 0.29));
  vec4 b = texture(uNoise, p * 2.070 + vec3(0.61, 0.19, 0.83));
  vec4 c = texture(uNoise, p * 4.130 + vec3(0.37, 0.53, 0.11));
  float f1 = (a.x - 0.5) * 0.52 + (b.y - 0.5) * 0.30 + (c.z - 0.5) * 0.16;
  float f2 = (a.w - 0.5) * 0.52 + (b.z - 0.5) * 0.30 + (c.x - 0.5) * 0.16;
  // Normalised, and this was worth a whole round of chasing the wrong problem.
  // Trilinear-smoothed lattice value noise does not fill [-0.5, 0.5]; its
  // standard deviation is about 0.14, so a weighted sum of three octaves comes
  // out with a deviation near 0.09 — a field that never leaves the middle of
  // its own range. Every density curve downstream was written expecting
  // something like unit variance, so the medium had no gaps, no knots and no
  // contrast, and the symptom was a sky that looked like a wash however the
  // colours were balanced. The scale here is what puts the deviation near 0.3
  // and the range near +/-0.85, which is what those curves were drawn for.
  return vec2(f1, f2) * 3.4;
}

/** One fetch, one octave. For shadow rays, where a smooth field is enough. */
float fbm1(vec3 p) {
  return texture(uNoise, p * 1.000 + vec3(0.13, 0.71, 0.29)).x - 0.5;
}

/**
 * Curl of a noise vector potential — the difference between gas and cloud.
 *
 * A domain warp displaces the field; a *curl* warp advects it along a
 * divergence-free flow, which is what shears a blob into a filament and is
 * exactly what a real nebula has been doing for a million years under
 * differential rotation and stellar winds. Pure fBm gives you weather. This
 * gives you something that has been pulled.
 *
 * Six fetches, and that is the whole reason the potential is one fetch rather
 * than the usual two-octave stack: twelve fetches a march sample was measured
 * as the difference between a bake that fits in a frame's spare time and one
 * that does not. The coarse curl is enough because the bake is deliberately the
 * *low-frequency* half of this picture — the sharp filaments are added live, at
 * screen resolution, in Nebula.ts.
 */
vec3 curl3(vec3 p, float e) {
  vec3 dx = texture(uNoise, p + vec3(e, 0.0, 0.0)).xyz
          - texture(uNoise, p - vec3(e, 0.0, 0.0)).xyz;
  vec3 dy = texture(uNoise, p + vec3(0.0, e, 0.0)).xyz
          - texture(uNoise, p - vec3(0.0, e, 0.0)).xyz;
  vec3 dz = texture(uNoise, p + vec3(0.0, 0.0, e)).xyz
          - texture(uNoise, p - vec3(0.0, 0.0, e)).xyz;
  return vec3(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x) / (2.0 * e);
}
`;
