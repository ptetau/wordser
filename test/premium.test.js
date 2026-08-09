import { test } from 'node:test';
import assert from 'node:assert/strict';
import { premiumAt, PERIOD } from '../public/engine/premium.js';

test('pattern recurs with period 12 in both axes', () => {
  for (let x = -14; x <= 14; x += 3) {
    for (let y = -14; y <= 14; y += 3) {
      const p = premiumAt(x, y);
      assert.equal(premiumAt(x + PERIOD, y), p);
      assert.equal(premiumAt(x, y + PERIOD), p);
      assert.equal(premiumAt(x - PERIOD, y - PERIOD), p);
    }
  }
});

test('word premiums dot the criss-crossing diagonals', () => {
  assert.equal(premiumAt(0, 0), 'TW'); // u=0, v=0: diagonal intersection
  assert.equal(premiumAt(6, 6), 'TW'); // u=12≡0, v=0
  assert.equal(premiumAt(3, -3), 'DW'); // u=0, v=6
  assert.equal(premiumAt(3, 3), 'DW'); // u=6, v=0
});

test('letter premiums sit between the word diagonals', () => {
  assert.equal(premiumAt(6, 0), 'TL'); // u=6, v=6
  assert.equal(premiumAt(3, 0), 'DL'); // u=3, v=3
  assert.equal(premiumAt(0, 3), 'DL'); // u=3, v=9
  assert.equal(premiumAt(6, 3), 'DL'); // u=9, v=3
});

test('the pattern is sparse between the dots', () => {
  assert.equal(premiumAt(1, 0), null);
  assert.equal(premiumAt(2, 0), null);
  assert.equal(premiumAt(4, 0), null);
  assert.equal(premiumAt(4, 4), null);
  assert.equal(premiumAt(1, 1), null);
  // Density stays well under a classic board's ~27%.
  let premium = 0;
  const total = PERIOD * PERIOD;
  for (let x = 0; x < PERIOD; x++) {
    for (let y = 0; y < PERIOD; y++) if (premiumAt(x, y)) premium++;
  }
  assert.ok(premium / total < 0.15, `density ${premium}/${total}`);
});

test('negative coordinates behave like positive ones', () => {
  assert.equal(premiumAt(-6, 6), 'TW'); // u=0, v=-12≡0
  assert.equal(premiumAt(-3, 3), 'DW');
  assert.equal(premiumAt(-3, 0), 'DL'); // u=-3≡9, v=-3≡9
});
