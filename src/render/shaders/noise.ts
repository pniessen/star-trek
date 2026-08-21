/**
 * The noise bench — GLSL source as strings, for the fragment shaders that
 * paint celestial bodies.
 *
 * Three files had grown their own copy of the same ladder. `GasGiant.ts`
 * wrote it first (`hash31` → `noise3` → `fbm3` → `flow`), `Nebula.ts` copied
 * it verbatim and changed one loop bound, and `Moon.ts` wrote a cellular
 * variant beside it. `Nebula.ts`'s own comment defended the copy — "a shader
 * include mechanism is a build step this project does not have, and two
 * forty-line functions that are allowed to diverge are cheaper than one that
 * cannot" — and the first half of that is simply wrong: a template literal
 * interpolated into another template literal *is* the include mechanism, and
 * it needs no build step, because this project already ships every shader as
 * a TypeScript string. The second half is a real argument and it is the
 * reason this module exports the ladder in *rungs* rather than as one blob:
 * a body that needs to diverge takes the rungs it agrees with and writes its
 * own for the rest, which is what `Moon.ts` does today (it wants `hash31`'s
 * neighbourhood and none of `fbm3`'s). Divergence stays available; accidental
 * divergence — three copies drifting because nobody noticed the other two —
 * does not.
 *
 * **Order matters.** GLSL ES has no forward declarations in practice, so
 * these must be concatenated in dependency order: `HASH31` before `NOISE3`,
 * `NOISE3` before `fbm3(n)`, `fbm3(n)` before `FLOW`. `flowLadder(n)` does
 * exactly that and is what both flow-field consumers actually interpolate;
 * the individual constants are exported for a body that wants only part of
 * the stack.
 *
 * **Nothing here reads a uniform.** Every rung is a pure function of its
 * arguments, which is the one property that let three shaders with three
 * different uniform vocabularies (`uWarpStrength`, `uWarp`, and whatever
 * comes next) share one body of code. `FLOW` in particular takes its warp
 * strength as an argument rather than reaching for a uniform by name, which
 * is the only signature change this extraction made — the arithmetic is
 * byte-for-byte what `GasGiant.ts` and `Nebula.ts` were each already doing.
 */

/**
 * Hash on an integer lattice point, three-dimensional rather than two.
 *
 * Whether the resulting field is *periodic* is a property of how the caller
 * embeds its coordinates, not of this function — `GasGiant.ts`'s `flowPoint`
 * puts longitude on a unit circle before it ever gets here, which is what
 * closes the `lon = ±π` seam without constraining every frequency in that
 * shader to an integer. See that function's own comment; the trade it makes
 * (a cylinder, not a sphere) is its to make, not this file's.
 */
export const HASH31 = /* glsl */ `
float hash31(vec3 p) {
  p = fract(p * vec3(127.1, 311.7, 74.7));
  p += dot(p, p.yzx + 34.45);
  return fract((p.x + p.y) * p.z);
}
`;

/**
 * Trilinear value noise on the `HASH31` lattice, smoothstep-interpolated on
 * each axis. Requires `HASH31` to appear before it in the shader source.
 */
export const NOISE3 = /* glsl */ `
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}
`;

/**
 * Fractal Brownian motion over `NOISE3` — each octave half the amplitude and
 * twice the frequency of the last, summed in signed `[-1, 1]` form.
 *
 * **A factory rather than fixed 4- and 5-octave variants**, and the choice is
 * forced by two facts pulling the same way. GLSL ES 3.0 requires a loop bound
 * the compiler can fold to a constant, so the count cannot be a uniform and
 * has to be baked into the emitted source either way. And the octave count is
 * already a *tuning decision each body makes for itself*, with its reasoning
 * recorded at the call site: the giant holds to four because `flow` evaluates
 * this three times per fragment across a body that fills a third of the
 * frame, and the nebula wants five because it fills the whole sky and its
 * smallest features have to survive being looked at directly. Fixed variants
 * would turn that into a menu — `FBM3_4`, `FBM3_5`, and a new export the
 * first time a body wants six — and would put the count in a *name* rather
 * than beside the argument for it. A factory emits one `fbm3` per shader at
 * whatever count that shader argued for, and leaves the argument where it
 * belongs.
 *
 * The emitted function is always called `fbm3`, so a shader may interpolate
 * this exactly once; `FLOW` below calls it by that name.
 *
 * Requires `HASH31` and `NOISE3` before it.
 */
export function fbm3(octaves: number): string {
  // A non-integer or non-positive count would emit GLSL that either fails to
  // compile or silently sums nothing, and a shader compile error surfaces as
  // a black mesh with a console warning several layers from the cause. One
  // line here is cheaper than that hunt.
  if (!Number.isInteger(octaves) || octaves < 1) {
    throw new Error(`fbm3: octave count must be a positive integer, got ${octaves}`);
  }
  return /* glsl */ `
float fbm3(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < ${octaves}; i++) {
    sum += amp * (noise3(p * freq) * 2.0 - 1.0);
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}
`;
}

/**
 * Domain warping — `fbm(p + fbm(p + fbm(p)))` literally: each nested call
 * displaces the next along all three axes by the same scalar, which is what
 * turns a smooth gradient into curls and festoons instead of a blob. It is
 * the whole difference between a cloud and a smudge.
 *
 * Three nested `fbm3` calls rather than the more usual vector-valued warp (a
 * `vec2`/`vec3` built from two or three extra `fbm3` evaluations per level)
 * — this is the same picture at roughly a third of the cost, and at a
 * sphere's worth of fragments that cost is what caps the octave count each
 * caller picks, not visual quality.
 *
 * `warp` is an argument rather than a uniform read by name: the two callers
 * had already named that uniform two different things (`uWarpStrength` and
 * `uWarp`), so a uniform reference would have made this rung unshareable
 * over a difference that carries no meaning. Passing it in leaves each
 * shader's own uniform vocabulary alone.
 *
 * Requires `fbm3(n)` before it.
 */
export const FLOW = /* glsl */ `
float flow(vec3 p, float warp) {
  float a = fbm3(p);
  float b = fbm3(p + warp * a + vec3(3.1, 1.7, 5.9));
  float c = fbm3(p + warp * b + vec3(7.2, 4.1, 2.3));
  return c;
}
`;

/**
 * The whole flow ladder in dependency order — `HASH31`, `NOISE3`,
 * `fbm3(octaves)`, `FLOW` — which is what both flow-field bodies actually
 * want. Exported as a helper rather than leaving four interpolations at every
 * call site because the *order* is a correctness requirement (see this file's
 * header) and a requirement that lives only in a comment is one a later
 * shader gets wrong once.
 */
export function flowLadder(octaves: number): string {
  return HASH31 + NOISE3 + fbm3(octaves) + FLOW;
}

/**
 * Cellular (Worley) noise on a 2D lattice: distance to the nearest of nine
 * jittered neighbouring feature points, in `[0, 1]`-ish. Craters are pits,
 * not weather — where `FLOW` above gives you fields that curl, this gives you
 * fields with *centres*, which is the shape a crater, a cell or a scale has
 * and an fbm never will.
 *
 * **Two-dimensional, and named for it.** The obvious symmetry with `NOISE3`
 * argues for a `vec3` version, and there is a real one to write the day a
 * body needs a seam-free cellular field on a sphere the way `flowPoint`
 * needed a seam-free value field. `Moon.ts`, the only caller, samples a flat
 * `(lon, lat)` pair and accepts the seam its own crater density hides, so a
 * `vec3` variant today would be a third of a rung nobody calls, sharing a
 * name with the one they do. When that body arrives it gets `WORLEY3`
 * beside this, not instead of it — the 2D one is cheaper (nine cells against
 * twenty-seven) and stays right for anything sampled on a plane.
 *
 * Self-contained: `hash2` is its own, unrelated to `HASH31` above, so this
 * may be interpolated alone.
 */
export const WORLEY2 = /* glsl */ `
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float worley(vec2 p) {
  vec2 cell = floor(p); vec2 f = fract(p);
  float d = 1.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = hash2(cell + g);
    d = min(d, length(g + o - f));
  }
  return d;
}
`;
