import { test } from 'node:test';
import assert from 'node:assert/strict';
import { premiumAt, PERIOD } from '../public/engine/premium.js';
import { WORLD } from '../public/engine/board.js';

test('pattern recurs with the tile period in both axes', () => {
  for (let x = -32; x <= 32; x += 5) {
    for (let y = -32; y <= 32; y += 5) {
      const p = premiumAt(x, y);
      assert.equal(premiumAt(x + PERIOD, y), p);
      assert.equal(premiumAt(x, y + PERIOD), p);
      assert.equal(premiumAt(x - PERIOD, y - PERIOD), p);
    }
  }
});

test('the origin is a double-word start star and the motifs are classic', () => {
  assert.equal(premiumAt(0, 0), 'DW'); // board-centre star under the start cell
  assert.equal(premiumAt(7, 7), 'TW'); // board corner, 7 squares out
  assert.equal(premiumAt(-7, 7), 'TW');
  assert.equal(premiumAt(6, 6), 'DW'); // double-word diagonal X
  assert.equal(premiumAt(9, 9), 'DW'); // its mirror in the next board along
  assert.equal(premiumAt(2, 2), 'TL'); // triple-letter diamond
  assert.equal(premiumAt(1, 1), 'DL');
  assert.equal(premiumAt(0, 4), 'DL');
});

test('the gaps between motifs are empty', () => {
  assert.equal(premiumAt(1, 0), null);
  assert.equal(premiumAt(5, 0), null);
  assert.equal(premiumAt(6, 0), null);
  assert.equal(premiumAt(2, 1), null);
  let premium = 0;
  for (let x = 0; x < PERIOD; x++) {
    for (let y = 0; y < PERIOD; y++) if (premiumAt(x, y)) premium++;
  }
  // A real scrabble board carries 61 premiums in 225 squares.
  const density = premium / (PERIOD * PERIOD);
  assert.ok(density > 0.2 && density < 0.32, `density ${density}`);
});

test('negative coordinates behave like positive ones', () => {
  assert.equal(premiumAt(-15, 0), 'DW'); // one whole board back
  assert.equal(premiumAt(-6, -6), 'DW');
  assert.equal(premiumAt(-2, -2), 'TL');
});

test('the tiling closes seamlessly around the world', () => {
  // The pattern only meets itself at the seam if the tile divides the
  // world — the whole reason the board carries a gutter.
  assert.equal(WORLD % PERIOD, 0, `${PERIOD}-cell tile must divide the ${WORLD}-cell world`);
  for (let x = -3; x <= 3; x++) {
    for (let y = -3; y <= 3; y++) {
      assert.equal(premiumAt(x + WORLD, y), premiumAt(x, y), `seam breaks at x=${x}`);
      assert.equal(premiumAt(x, y + WORLD), premiumAt(x, y), `seam breaks at y=${y}`);
    }
  }
});

test('boards sit edge to edge, sharing their triple-word rims', () => {
  // Two boards meet between x=7 and x=8: both carry the classic TW edge,
  // exactly as two boards laid side by side on a table would.
  assert.equal(premiumAt(7, 0), 'TW');
  assert.equal(premiumAt(8, 0), 'TW');
  assert.equal(premiumAt(15, 15), 'DW'); // the next board's centre star
  assert.equal(premiumAt(15, 0), 'DW'); // ...and its centre row
});

test('every lattice star the day can move to is a real board centre', () => {
  for (let x = 0; x < WORLD; x += PERIOD) {
    for (let y = 0; y < WORLD; y += PERIOD) {
      assert.equal(premiumAt(x, y), 'DW', `lattice point ${x},${y} is not a star`);
    }
  }
});
