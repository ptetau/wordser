import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError } from '../public/engine/game.js';
import { makeGame, tilesFor } from './helpers.js';

test('exchanging swaps rack letters for fresh ones and uses the turn', () => {
  const g = makeGame(['cat'], {
    racks: [
      ['q', 'q', 'v', 'e', 'e', 'e', 'e'],
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
    ],
  });
  const bagBefore = g.bag.pool.length;
  const r = g.exchange({ playerId: 0, letters: ['q', 'q', 'v'] });
  assert.equal(r.exchanged, 3);
  assert.equal(r.drawn, 3);
  assert.equal(g.players[0].rack.length, 7);
  assert.equal(g.bag.pool.length, bagBefore); // took 3, gave 3 back
  assert.equal(g.lastPlayerId, 0);
  // It used the turn: the friend rule now blocks player 0.
  assert.throws(() => g.exchange({ playerId: 0, letters: ['e'] }), /friend/);
  // But player 1 can still play a word afterwards.
  g.place({ playerId: 1, tiles: tilesFor('cat', 0, 0) });
});

test('exchanges are validated', () => {
  const g = makeGame(['cat'], { racks: [['a', 'b', 'c', 'd', 'e', 'f', 'g'], []] });
  assert.throws(() => g.exchange({ playerId: 0, letters: [] }), GameError);
  assert.throws(() => g.exchange({ playerId: 0, letters: ['z'] }), GameError); // not held
  assert.throws(
    () => g.exchange({ playerId: 0, letters: ['a', 'a'] }),
    GameError, // only one 'a' in the rack
  );
});

test('the day has one bag: when it runs dry, racks stop refilling', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.bag.pool = ['z']; // nearly dry
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  // Used three letters, but only one tile was left to draw.
  assert.equal(g.players[0].rack.length, 5);
  assert.equal(g.bag.pool.length, 0);
  // No exchange from an empty bag.
  assert.throws(() => g.exchange({ playerId: 1, letters: ['e'] }), GameError);
  // The new day brings a fresh 100-tile set and full racks.
  g.startNewDay();
  assert.equal(g.players[0].rack.length, 7);
  assert.ok(g.bag.pool.length > 80); // 100 minus the re-dealt racks
});
