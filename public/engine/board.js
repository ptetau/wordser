// Sparse octagonal board on a looping world.
//
// Cells are octagons in the truncated-square tiling (small squares fill the
// corner gaps, purely decoratively): octagon-to-octagon adjacency is a
// square lattice, so cells are addressed by (x, y) with x growing right and
// y growing down. Both axes wrap every WORLD cells — the world is a 120×120
// torus. Callers may use any integers; they are wrapped canonically.
//
// Words run along the two octagon edge directions:
//   h (1, 0)  read left → right
//   v (0, 1)  read top → bottom
//
// A tile is { letter } for a normal tile, or { isBlank: true, as } for a
// wildcard currently standing in for the letter `as`. Wildcards score 0 and
// can later be redefined to a different letter if every word through them
// stays real.

export const WORLD = 120;

export const DIRS = { h: [1, 0], v: [0, 1] };
export const DIR_NAMES = Object.keys(DIRS);

export const wrapCoord = (n) => ((n % WORLD) + WORLD) % WORLD;

const key = (x, y) => `${wrapCoord(x)},${wrapCoord(y)}`;

export class Board {
  constructor() {
    this.cells = new Map();
  }

  static key = key;

  /** The letter a tile currently represents. */
  static effective(tile) {
    return tile.isBlank ? tile.as : tile.letter;
  }

  get(x, y) {
    return this.cells.get(key(x, y)) ?? null;
  }

  set(x, y, tile) {
    this.cells.set(key(x, y), tile);
  }

  remove(x, y) {
    this.cells.delete(key(x, y));
  }

  isEmpty() {
    return this.cells.size === 0;
  }

  /**
   * The maximal run of tiles through (x, y) in direction dir (e/se/sw).
   * Returns { dir, cells: [{x, y, tile}], word } or null if (x, y) is empty.
   */
  wordThrough(x, y, dir) {
    if (!this.get(x, y)) return null;
    const [dx, dy] = DIRS[dir];
    let sx = x;
    let sy = y;
    // The world loops, so cap the scan at one full circuit (a solid ring).
    for (let steps = 0; steps < WORLD && this.get(sx - dx, sy - dy); steps++) {
      sx -= dx;
      sy -= dy;
    }
    const cells = [];
    let cx = sx;
    let cy = sy;
    for (let tile = this.get(cx, cy); tile && cells.length < WORLD; tile = this.get(cx, cy)) {
      cells.push({ x: cx, y: cy, tile });
      cx += dx;
      cy += dy;
    }
    return { dir, cells, word: cells.map((c) => Board.effective(c.tile)).join('') };
  }

  /** All maximal words (length >= 2) on the board. */
  allWords() {
    const seen = new Set();
    const words = [];
    for (const k of this.cells.keys()) {
      const [x, y] = k.split(',').map(Number);
      for (const dir of DIR_NAMES) {
        const w = this.wordThrough(x, y, dir);
        if (!w || w.cells.length < 2) continue;
        const id = `${dir}:${key(w.cells[0].x, w.cells[0].y)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        words.push(w);
      }
    }
    return words;
  }
}
