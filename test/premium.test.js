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
  assert.equal(premiumAt(14, 14), 'TW'); // board corner
  assert.equal(premiumAt(-14, 14), 'TW');
  assert.equal(premiumAt(12, 12), 'DW'); // double-word diagonal X
  assert.equal(premiumAt(20, 20), 'DW'); // its mirror in the next board
  assert.equal(premiumAt(18, 18), 'TW'); // the next board's corner
  assert.equal(premiumAt(4, 4), 'TL'); // triple-letter diamond
  assert.equal(premiumAt(2, 2), 'DL');
  assert.equal(premiumAt(0, 8), 'DL');
});

test('odd cells and the gaps between motifs are empty', () => {
  assert.equal(premiumAt(1, 0), null);
  assert.equal(premiumAt(1, 1), null);
  assert.equal(premiumAt(2, 0), null);
  assert.equal(premiumAt(6, 0), null);
  let premium = 0;
  for (let x = 0; x < PERIOD; x++) {
    for (let y = 0; y < PERIOD; y++) if (premiumAt(x, y)) premium++;
  }
  const density = premium / (PERIOD * PERIOD);
  assert.ok(density > 0.04 && density < 0.1, `density ${density}`);
});

test('negative coordinates behave like positive ones', () => {
  assert.equal(premiumAt(-32, 0), 'DW'); // one whole tile back
  assert.equal(premiumAt(-12, -12), 'DW');
  assert.equal(premiumAt(-4, -4), 'TL');
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

test('a plain gutter separates one board from the next', () => {
  // 16 cells from the centre star, right between two boards.
  for (let d = -14; d <= 14; d += 2) {
    assert.equal(premiumAt(16, d), null, `gutter column has a premium at y=${d}`);
    assert.equal(premiumAt(d, 16), null, `gutter row has a premium at x=${d}`);
  }
  // The boards either side of it are intact: corners at ±14 from each centre.
  assert.equal(premiumAt(14, 14), 'TW');
  assert.equal(premiumAt(18, 18), 'TW');
  assert.equal(premiumAt(32, 32), 'DW'); // the next board's centre star
});

test('every lattice star the day can move to is a real board centre', () => {
  for (let x = 0; x < WORLD; x += PERIOD) {
    for (let y = 0; y < WORLD; y += PERIOD) {
      assert.equal(premiumAt(x, y), 'DW', `lattice point ${x},${y} is not a star`);
    }
  }
});
