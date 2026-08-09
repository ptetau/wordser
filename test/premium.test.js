import { test } from 'node:test';
import assert from 'node:assert/strict';
import { premiumAt, PERIOD } from '../public/engine/premium.js';

test('pattern recurs with period 30 in both axes', () => {
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
  assert.equal(premiumAt(18, 18), 'DW'); // its mirror
  assert.equal(premiumAt(16, 16), 'TW'); // the next board's corner
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
  assert.equal(premiumAt(-30, 0), 'DW');
  assert.equal(premiumAt(-12, -12), 'DW');
  assert.equal(premiumAt(-4, -4), 'TL');
});
