// Which way should a new word run?
//
// When a player taps an empty cell we have to pick a direction before they
// have typed anything. Guessing well is worth real friction: the flip
// control exists, but reaching for it every time is a tax. These rules read
// the letters immediately around the cell — the ones the player can see —
// and stop there. A default that reacts to tiles four cells away feels
// haunted, so when the board says nothing we repeat the player's own last
// choice instead of getting clever.

import { DIRS } from './engine/board.js';

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

  // Nothing to go on: stay predictable rather than guess.
  return lastDir === 'v' ? 'v' : 'h';
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
      let usable = true;
      for (let i = 0; i < len; i++) {
        const cx = x + (start + i) * dx;
        const cy = y + (start + i) * dy;
        const sitting = board.get(cx, cy);
        if (sitting) word.push(sitting.isBlank ? sitting.as : sitting.letter);
        else if (word.length < len) word.push(null); // a blank to fill from the rack
        if (word.length > len) usable = false;
      }
      if (!usable) continue;
      // Try the rack in the holes, first fit only — this is a smell test.
      const pool = [...letters];
      const filled = word.map((l) => (l === null ? pool.shift() : l));
      if (filled.some((l) => !l)) continue;
      if (dictionary.has(filled.join(''))) found++;
    }
  }
  return found;
}
