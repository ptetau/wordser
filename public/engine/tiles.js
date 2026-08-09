// Tile values and letter distribution (standard English Scrabble set).
// The bag holds exactly one standard 100-tile set per day, drawn without
// replacement so racks follow the real scrabble letter frequencies. When
// the day's bag runs dry it stays dry — a fresh set arrives with the new
// day (Game.startNewDay refills it).

export const BLANK = '*';

export const LETTER_VALUES = {
  a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1, j: 8, k: 5, l: 1,
  m: 3, n: 1, o: 1, p: 3, q: 10, r: 1, s: 1, t: 1, u: 1, v: 4, w: 4, x: 8,
  y: 4, z: 10, [BLANK]: 0,
};

export const DISTRIBUTION = {
  a: 9, b: 2, c: 2, d: 4, e: 12, f: 2, g: 3, h: 2, i: 9, j: 1, k: 1, l: 4,
  m: 2, n: 6, o: 8, p: 2, q: 1, r: 6, s: 4, t: 6, u: 4, v: 2, w: 2, x: 1,
  y: 2, z: 1, [BLANK]: 2,
};

/** Small deterministic PRNG for reproducible games/tests. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Bag {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.pool = [];
    this.refill();
  }

  /** Start over with a fresh full 100-tile set. */
  refill() {
    this.pool = [];
    for (const [letter, count] of Object.entries(DISTRIBUTION)) {
      for (let i = 0; i < count; i++) this.pool.push(letter);
    }
  }

  /** Draw one tile letter ('a'-'z' or BLANK), or null when the bag is dry. */
  draw() {
    if (this.pool.length === 0) return null;
    const i = Math.floor(this.rng() * this.pool.length);
    return this.pool.splice(i, 1)[0];
  }
}
