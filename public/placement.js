// Which way should a new word run?
//
// When a player taps an empty cell we have to pick a direction before they
// have typed anything. Guessing well is worth real friction: the flip
// control exists, but reaching for it every time is a tax.
//
// The rules read the letters immediately around the cell first — a slot, a
// neighbour, a corner — because those are the strongest statements a board
// can make. When nothing is touching, the arrow points at the nearest word
// instead: along the axis that word lies on, so spelling and then sliding
// with the arrow keys walks you into it.

import { DIRS } from './engine/board.js';

/** How far out to look for the nearest word before giving up. */
export const LOOK = 10;

/**
 * Pick the likeliest direction for a word starting on the empty cell
 * (x, y). Board signals win over habit; habit wins over nothing.
 *
 * @param {import('./engine/board.js').Board} board
 * @param {number} x
 * @param {number} y
 * @param {{rackSize?: number, lastDir?: 'h'|'v'}} [opts]
 * @returns {'h'|'v'}
 */
export function defaultDirection(board, x, y, { rackSize = 7, lastDir = 'h' } = {}) {
  // A fresh board always reads left-to-right off the ★.
  if (board.isEmpty()) return 'h';

  const occupied = (dx, dy) => Boolean(board.get(x + dx, y + dy)); // wraps
  const before = { h: occupied(-1, 0), v: occupied(0, -1) };
  const after = { h: occupied(1, 0), v: occupied(0, 1) };

  // Sandwiched along one axis: a single tile here closes a word on that
  // axis, which is about the strongest intent a board can express.
  const slot = { h: before.h && after.h, v: before.v && after.v };
  if (slot.h !== slot.v) return slot.h ? 'h' : 'v';

  // A neighbour on exactly one axis: run along it. Placing folds that
  // neighbour into the word, so this extends and hooks alike — and a cell
  // under a horizontal word touches only vertically, which is exactly the
  // hook the player is reaching for.
  const touch = { h: before.h || after.h, v: before.v || after.v };
  if (touch.h !== touch.v) return touch.h ? 'h' : 'v';

  // An inside corner, letters on both axes: head for the open ground.
  // Room beyond the rack is unusable, so stop counting there.
  if (touch.h && touch.v) {
    const room = (dir) => {
      const [dx, dy] = DIRS[dir];
      let n = 0;
      while (n < rackSize && !board.get(x + (n + 1) * dx, y + (n + 1) * dy)) n++;
      return n;
    };
    const across = room('h');
    const down = room('v');
    if (across !== down) return across > down ? 'h' : 'v';
  }

  // Nothing is touching: point at the nearest word instead of guessing.
  return nearestWordDirection(board, x, y) ?? (lastDir === 'v' ? 'v' : 'h');
}

/**
 * The axis the closest letters lie on, or null when the board is empty for
 * `LOOK` cells in every direction.
 *
 * Rings are searched from the inside out and the first one with an opinion
 * wins, so a word two cells away always beats one nine cells away. Within a
 * ring each letter votes for the axis it is furthest along: a letter three
 * rows up and none across is a vote for the column. That is the useful
 * answer even when the word is *behind* the cursor, because a word spelled
 * down the same column can be slid up into it with the arrow keys, while a
 * word spelled across can never reach it at all.
 */
export function nearestWordDirection(board, x, y, { look = LOOK } = {}) {
  for (let r = 1; r <= look; r++) {
    let h = 0;
    let v = 0;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // this ring only
        if (!board.get(x + dx, y + dy)) continue;
        if (Math.abs(dx) > Math.abs(dy)) h++;
        else if (Math.abs(dy) > Math.abs(dx)) v++;
        // Exact diagonals say nothing about an axis, so they don't vote.
      }
    }
    if (h !== v) return h > v ? 'h' : 'v';
  }
  return null;
}

/**
 * Which way a word could actually be played from here. The geometry above
 * says what a player probably means; this says what the board and their
 * rack allow, and it wins when the two disagree — pointing at an axis
 * where nothing can be spelled is worse than useless.
 *
 * Bounded on purpose: a handful of candidate words per direction, checked
 * against the dictionary, is plenty to tell a live axis from a dead one,
 * and it has to run on every tap.
 */
export function feasibleDirection(board, x, y, { rack = [], dictionary, lastDir = 'h', rackSize } = {}) {
  const geometric = defaultDirection(board, x, y, { rackSize: rackSize ?? rack.length, lastDir });
  if (!dictionary || !rack.length) return geometric;
  const score = (dir) => countPlayable(board, x, y, dir, rack, dictionary);
  const across = score('h');
  const down = score('v');
  if (across === down) return geometric; // no opinion: fall back to the shape
  const feasible = across > down ? 'h' : 'v';
  // Only overrule the geometry when it points somewhere truly dead.
  return score(geometric) === 0 ? feasible : geometric;
}

/** How many of a few quick candidate words would be legal along `dir`. */
function countPlayable(board, x, y, dir, rack, dictionary) {
  const [dx, dy] = DIRS[dir];
  const letters = rack.filter((l) => l !== '*');
  if (!letters.length) return 0;
  let found = 0;
  // Read what is already on this line around the cell, then try short words
  // that fit the gap: enough to know whether anything can go here at all.
  for (let len = 2; len <= 4 && found < 2; len++) {
    for (let start = -(len - 1); start <= 0 && found < 2; start++) {
      const word = [];
      const holes = [];
      let usable = true;
      for (let i = 0; i < len; i++) {
        const cx = x + (start + i) * dx;
        const cy = y + (start + i) * dy;
        const sitting = board.get(cx, cy);
        if (sitting) word.push(sitting.isBlank ? sitting.as : sitting.letter);
        else if (word.length < len) {
          holes.push({ cx, cy, at: word.length });
          word.push(null); // a blank to fill from the rack
        }
        if (word.length > len) usable = false;
      }
      if (!usable) continue;
      // Try the rack in the holes, first fit only — this is a smell test.
      const pool = [...letters];
      const filled = word.map((l) => (l === null ? pool.shift() : l));
      if (filled.some((l) => !l)) continue;
      if (!dictionary.has(filled.join(''))) continue;
      // A word that only works by making nonsense sideways isn't playable —
      // this is what tells a live axis from one that runs along a wall.
      if (holes.every((h) => crossOk(board, h.cx, h.cy, filled[h.at], dir, dictionary))) {
        found++;
      }
    }
  }
  return found;
}

/**
 * Would dropping `letter` on this empty cell leave a real word across it?
 * Only the perpendicular run matters: the word being spelled is checked by
 * the caller.
 */
function crossOk(board, x, y, letter, dir, dictionary) {
  const [cdx, cdy] = DIRS[dir === 'h' ? 'v' : 'h'];
  const read = (sign) => {
    const out = [];
    for (let n = 1; n <= 20; n++) {
      const t = board.get(x + sign * n * cdx, y + sign * n * cdy);
      if (!t) break;
      out.push(t.isBlank ? t.as : t.letter);
    }
    return out;
  };
  const before = read(-1).reverse();
  const after = read(1);
  if (!before.length && !after.length) return true; // nothing beside it
  return dictionary.has([...before, letter, ...after].join(''));
}
