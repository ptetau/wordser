import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, WORLD } from '../public/engine/board.js';
import { defaultDirection } from '../public/placement.js';

/** A board with the given letters laid down: [x, y, letter]. */
const boardWith = (...tiles) => {
  const b = new Board();
  for (const [x, y, letter] of tiles) b.set(x, y, { letter: letter ?? 'a' });
  return b;
};
const word = (w, x, y, dir = 'h') =>
  [...w].map((l, i) => [x + (dir === 'h' ? i : 0), y + (dir === 'v' ? i : 0), l]);

test('an empty board reads left to right', () => {
  const b = new Board();
  assert.equal(defaultDirection(b, 0, 0), 'h');
  assert.equal(defaultDirection(b, 37, 400, { lastDir: 'v' }), 'h');
});

test('a letter to the side means extend across', () => {
  const b = boardWith(...word('cat', 0, 0));
  assert.equal(defaultDirection(b, 3, 0), 'h'); // right of the T: CATS
  assert.equal(defaultDirection(b, -1, 0), 'h'); // and to the left
});

test('a letter above or below means hook downward', () => {
  const b = boardWith(...word('cat', 0, 0));
  assert.equal(defaultDirection(b, 1, 1), 'v'); // under the A
  assert.equal(defaultDirection(b, 2, -1), 'v'); // over the T
});

test('perpendicular contact runs along the free axis', () => {
  const b = boardWith(...word('cat', 0, 0, 'v'));
  assert.equal(defaultDirection(b, 1, 1), 'h'); // beside a vertical word
});

test('a one-cell slot wins over a plain neighbour', () => {
  // Sandwiched horizontally, but also touching a tile above: the slot wins.
  const b = boardWith([0, 0, 'a'], [2, 0, 'b'], [1, -1, 'c']);
  assert.equal(defaultDirection(b, 1, 0), 'h');
});

test('an inside corner heads for the open ground', () => {
  //           (3,-1)
  //   (2,0) [tap 3,0]
  //           (3,2)  ← only one free cell downward
  const b = boardWith([2, 0, 'a'], [3, -1, 'b'], [3, 2, 'c']);
  assert.equal(defaultDirection(b, 3, 0, { rackSize: 7 }), 'h');

  // Flip the obstruction: now downward is the open axis.
  const b2 = boardWith([2, 0, 'a'], [3, -1, 'b'], [5, 0, 'c']);
  assert.equal(defaultDirection(b2, 3, 0, { rackSize: 7 }), 'v');
});

test('a dead-heat corner falls back to the last direction chosen', () => {
  const b = boardWith([2, 0, 'a'], [3, -1, 'b']); // room is open both ways
  assert.equal(defaultDirection(b, 3, 0, { lastDir: 'v' }), 'v');
  assert.equal(defaultDirection(b, 3, 0, { lastDir: 'h' }), 'h');
});

test('an isolated cell refuses to be clever and repeats the last choice', () => {
  const b = boardWith(...word('cat', 0, 0));
  assert.equal(defaultDirection(b, 10, 10, { lastDir: 'v' }), 'v');
  assert.equal(defaultDirection(b, 10, 10, { lastDir: 'h' }), 'h');
  assert.equal(defaultDirection(b, 10, 10), 'h'); // no habit yet
});

test('neighbours are found across the seam', () => {
  const b = boardWith([WORLD - 1, 7, 'a']);
  assert.equal(defaultDirection(b, 0, 7), 'h'); // its left neighbour wraps
});

test('room is capped by the rack, so a small rack ties and defers to habit', () => {
  // Down room 2, across room open — but with two tiles in hand both are 2.
  const b = boardWith([2, 0, 'a'], [3, -1, 'b'], [3, 3, 'c']);
  assert.equal(defaultDirection(b, 3, 0, { rackSize: 7 }), 'h'); // 7 vs 2
  assert.equal(defaultDirection(b, 3, 0, { rackSize: 2, lastDir: 'v' }), 'v'); // 2 vs 2
});

test('a fully enclosed cell still answers', () => {
  const b = boardWith([0, 1, 'a'], [2, 1, 'b'], [1, 0, 'c'], [1, 2, 'd']);
  assert.ok(['h', 'v'].includes(defaultDirection(b, 1, 1)));
});
