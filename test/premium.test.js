import { test } from 'node:test';
import assert from 'node:assert/strict';
import { premiumAt, PERIOD } from '../public/engine/premium.js';

test('pattern recurs with period 14 in both axes', () => {
  for (let x = -16; x <= 16; x += 3) {
    for (let y = -16; y <= 16; y += 3) {
      const p = premiumAt(x, y);
      assert.equal(premiumAt(x + PERIOD, y), p);
      assert.equal(premiumAt(x, y + PERIOD), p);
      assert.equal(premiumAt(x - PERIOD, y - PERIOD), p);
    }
  }
});

test('the classic scrabble motifs are all present', () => {
  // Triple-word corners and mid-edges.
  assert.equal(premiumAt(0, 0), 'TW');
  assert.equal(premiumAt(7, 0), 'TW');
  assert.equal(premiumAt(0, 7), 'TW');
  // Double-word diagonal X, including the board-centre star.
  assert.equal(premiumAt(1, 1), 'DW');
  assert.equal(premiumAt(4, 4), 'DW');
  assert.equal(premiumAt(13, 13), 'DW'); // mirror of (1,1)
  assert.equal(premiumAt(7, 7), 'DW');
  // Triple-letter diamond.
  assert.equal(premiumAt(5, 1), 'TL');
  assert.equal(premiumAt(1, 5), 'TL');
  assert.equal(premiumAt(5, 5), 'TL');
  assert.equal(premiumAt(9, 13), 'TL'); // mirror of (5,1)
  // Double-letter positions.
  assert.equal(premiumAt(3, 0), 'DL');
  assert.equal(premiumAt(6, 6), 'DL');
  assert.equal(premiumAt(7, 3), 'DL');
  assert.equal(premiumAt(2, 6), 'DL');
});

test('the spaces between stay empty and density is classic-like', () => {
  assert.equal(premiumAt(1, 0), null);
  assert.equal(premiumAt(2, 0), null);
  assert.equal(premiumAt(5, 0), null);
  assert.equal(premiumAt(2, 1), null);
  let premium = 0;
  for (let x = 0; x < PERIOD; x++) {
    for (let y = 0; y < PERIOD; y++) if (premiumAt(x, y)) premium++;
  }
  const density = premium / (PERIOD * PERIOD);
  assert.ok(density > 0.15 && density < 0.35, `density ${density}`);
});

test('negative coordinates behave like positive ones', () => {
  assert.equal(premiumAt(-14, 0), 'TW');
  assert.equal(premiumAt(-1, -1), 'DW'); // ≡ (13,13), mirror of (1,1)
  assert.equal(premiumAt(-3, 0), 'DL'); // ≡ (11,0), mirror of (3,0)
});
