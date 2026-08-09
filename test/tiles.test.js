import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bag, DISTRIBUTION, mulberry32 } from '../public/engine/tiles.js';

test('the bag draws one full scrabble set, then runs dry until refilled', () => {
  const bag = new Bag(mulberry32(5));
  const counts = {};
  for (let i = 0; i < 100; i++) {
    const l = bag.draw();
    counts[l] = (counts[l] ?? 0) + 1;
  }
  assert.deepEqual(counts, DISTRIBUTION);
  // The day's set is gone: the bag stays dry until the next refill.
  assert.equal(bag.draw(), null);
  bag.refill();
  const counts2 = {};
  for (let i = 0; i < 100; i++) {
    const l = bag.draw();
    counts2[l] = (counts2[l] ?? 0) + 1;
  }
  assert.deepEqual(counts2, DISTRIBUTION);
});

test('a rack can never hold more of a letter than the set contains', () => {
  const bag = new Bag(mulberry32(11));
  for (let round = 0; round < 5; round++) {
    const seen = {};
    for (let i = 0; i < 100; i++) {
      const l = bag.draw();
      seen[l] = (seen[l] ?? 0) + 1;
      assert.ok(seen[l] <= DISTRIBUTION[l], `${l} over-drawn`);
    }
    bag.refill();
  }
});
