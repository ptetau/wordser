import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError } from '../public/engine/game.js';
import { makeGame, tilesFor } from './helpers.js';

test('passing consumes the turn under the friend rule', () => {
  const g = makeGame(['cat']);
  const r = g.pass({ playerId: 0 });
  assert.deepEqual(r, { passed: true, dayEnded: false, points: 0 });
  assert.equal(g.lastPlayerId, 0);
  assert.throws(() => g.pass({ playerId: 0 }), /friend/);
  g.pass({ playerId: 1 });
});

test('all passing on an empty bag ends the day', () => {
  const g = makeGame(['cat'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['e', 'e', 'e', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.players[0].score = 20;
  g.bag.pool = [];
  g.pass({ playerId: 1 });
  const r = g.pass({ playerId: 0 });
  assert.equal(r.dayEnded, true);
  assert.equal(g.day, 2);
  assert.equal(g.players[0].stars, 1); // the day's leader got the star
  assert.equal(g.players[0].score, 0);
  assert.ok(g.bag.pool.length > 80); // fresh bag, racks re-dealt
  assert.equal(g.players[1].rack.length, 7);
  assert.equal(g.passed.size, 0);
});

test('passing with tiles still in the bag never ends the day', () => {
  const g = makeGame(['cat']);
  g.pass({ playerId: 0 });
  const r = g.pass({ playerId: 1 });
  assert.equal(r.dayEnded, false);
  assert.equal(g.day, 1);
});

test('a real move between passes resets the streak', () => {
  const g = makeGame(['cat', 'cot'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.bag.pool = [];
  g.pass({ playerId: 1 });
  g.players[0].rack = ['o'];
  g.swap({ playerId: 0, swaps: [{ x: 1, y: 0, letter: 'o' }] }); // resets the streak
  g.pass({ playerId: 1 });
  assert.equal(g.day, 1); // only player 1 has passed since that word
  const r = g.pass({ playerId: 0 });
  assert.equal(r.dayEnded, true);
  assert.equal(g.day, 2);
});

test('the pass streak survives serialization', async () => {
  const { Game } = await import('../public/engine/game.js');
  const { Dictionary } = await import('../public/engine/dictionary.js');
  const g = makeGame(['cat']);
  g.pass({ playerId: 0 });
  const g2 = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), {
    dictionary: new Dictionary(['cat']),
  });
  assert.deepEqual([...g2.passed], [0]);
  g2.bag.pool = [];
  const r = g2.pass({ playerId: 1 });
  assert.equal(r.dayEnded, true);
});
