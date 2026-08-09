import { test } from 'node:test';
import assert from 'node:assert/strict';
import { premiumAt, PERIOD } from '../src/engine/premium.js';

test('pattern recurs with period 8 in both axes', () => {
  for (let x = -10; x <= 10; x += 3) {
    for (let y = -10; y <= 10; y += 3) {
      const p = premiumAt(x, y);
      assert.equal(premiumAt(x + PERIOD, y), p);
      assert.equal(premiumAt(x, y + PERIOD), p);
      assert.equal(premiumAt(x - PERIOD, y - PERIOD), p);
    }
  }
});

test('word premiums dot the criss-crossing diagonals', () => {
  assert.equal(premiumAt(0, 0), 'TW'); // u=0, v=0: diagonal intersection
  assert.equal(premiumAt(4, 4), 'TW'); // u=8≡0, v=0
  assert.equal(premiumAt(2, -2), 'DW'); // u=0, v=4
  assert.equal(premiumAt(2, 2), 'DW'); // u=4, v=0
});

test('letter premiums sit between the word diagonals', () => {
  assert.equal(premiumAt(4, 0), 'TL'); // u=4, v=4
  assert.equal(premiumAt(3, 1), 'DL'); // u=4, v=2
  assert.equal(premiumAt(5, 1), 'DL'); // u=6, v=4
  assert.equal(premiumAt(1, 1), null);
  assert.equal(premiumAt(2, 0), null); // between the dots
  assert.equal(premiumAt(3, 0), null);
});

test('negative coordinates behave like positive ones', () => {
  assert.equal(premiumAt(-4, -4), 'TW');
  assert.equal(premiumAt(-2, 2), 'DW');
  assert.equal(premiumAt(-8, 0), 'TW'); // u=-8≡0, v=-8≡0
});
