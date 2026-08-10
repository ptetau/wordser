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
