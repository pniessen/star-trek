/**
 * Grid geometry, kept free of anything that renders. The 8x8 is the 1971
 * geometry, reused.
 */
export const GRID = 8;
export const SECTOR_COUNT = GRID * GRID;

export function indexOf(col: number, row: number): number {
  return row * GRID + col;
}

export function colOf(index: number): number {
  return index % GRID;
}

export function rowOf(index: number): number {
  return Math.floor(index / GRID);
}

export function inBounds(col: number, row: number): boolean {
  return col >= 0 && col < GRID && row >= 0 && row < GRID;
}

/**
 * Orthogonal only. Diagonal adjacency would let the enemy advance on a
 * front twice as wide for the same pressure, which makes holding a line
 * impossible rather than hard.
 */
export function neighbours(index: number): number[] {
  const col = colOf(index);
  const row = rowOf(index);
  const out: number[] = [];
  for (const [dc, dr] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
    if (inBounds(col + dc, row + dr)) out.push(indexOf(col + dc, row + dr));
  }
  return out;
}
