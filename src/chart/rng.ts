/**
 * A seeded generator that carries its own cursor. The cursor is not a
 * convenience: a campaign is only reproducible if a reload resumes the
 * sequence rather than restarting it, and a restarted sequence silently
 * re-rolls the enemy's turn.
 */
export interface Rng {
  next(): number;
  readonly cursor: number;
}

/** mulberry32 — small, fast, and good enough for a strategy layer. */
export function makeRng(seed: number, cursor = 0): Rng {
  let drawn = 0;
  let state = seed >>> 0;

  const draw = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Fast-forward to where the save left off.
  for (let i = 0; i < cursor; i++) draw();

  return {
    next(): number {
      drawn++;
      return draw();
    },
    get cursor(): number {
      return cursor + drawn;
    },
  };
}
