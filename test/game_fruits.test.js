import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError, RACK_TARGET } from '../public/engine/game.js';
import { Game } from '../public/engine/game.js';
import { Dictionary } from '../public/engine/dictionary.js';
import { makeGame, tilesFor } from './helpers.js';

test('a lemon feeds you two extra letters', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.fruits.set('1,0', 'lemon');
  const r = g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.deepEqual(r.fruits, ['lemon']);
  assert.equal(g.fruits.has('1,0'), false);
  assert.equal(g.players[0].rack.length, RACK_TARGET + 2);
});

test('a chilli hands you a high-scoring letter', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.fruits.set('2,0', 'chilli');
  const r = g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.deepEqual(r.fruits, ['chilli']);
  assert.ok(g.players[0].rack.some((l) => 'jqxz'.includes(l)));
});

test('a cherry offers seven letters; choosing keeps one without using a turn', () => {
  const g = makeGame(['cat', 'ta'], {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['t', 'a', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  g.fruits.set('0,0', 'cherry');
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const offered = g.players[0].pendingChoice;
  assert.equal(offered.length, 7);

  const { letter } = g.apply({ type: 'choose', playerId: 0, index: 3 });
  assert.equal(letter, offered[3]);
  assert.ok(g.players[0].rack.includes(letter));
  assert.equal(g.players[0].pendingChoice, undefined);
  assert.throws(() => g.choosePendingLetter({ playerId: 0, index: 0 }), GameError);

  // Choosing was not a play: the friend rule still blocks Ana's next move.
  assert.throws(
    () => g.place({ playerId: 0, tiles: [{ x: 2, y: 1, letter: 'a' }] }),
    /friend/,
  );
});

test('a longer steal can grab a fruit beyond the old word', () => {
  const g = makeGame(['cat', 'cart', 'carts'], {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['r', 's', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.fruits.set('4,0', 'lemon');
  const r = g.stealReplace({ playerId: 1, x: 0, y: 0, dir: 'h', word: 'carts' });
  assert.deepEqual(r.fruits, ['lemon']);
  assert.equal(g.fruits.size, 0);
});

test('fruits spawn on empty cells near the board, capped at three', () => {
  const g = makeGame(['cat'], {
    players: ['Solo'],
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  for (let i = 0; i < 40; i++) g.spawnFruit(1);
  assert.ok(g.fruits.size >= 1);
  assert.ok(g.fruits.size <= 3);
  for (const k of g.fruits.keys()) {
    const [x, y] = k.split(',').map(Number);
    assert.equal(g.board.get(x, y), null);
    assert.ok(x >= -4 && x <= 6 && y >= -4 && y <= 4, `fruit at ${k} is near the word`);
  }
});

test('fruits and pending choices survive serialization', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.fruits.set('0,1', 'cherry');
  g.players[0].pendingChoice = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const g2 = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), {
    dictionary: new Dictionary(['cat']),
  });
  assert.equal(g2.fruits.get('0,1'), 'cherry');
  assert.deepEqual(g2.players[0].pendingChoice, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const { letter } = g2.choosePendingLetter({ playerId: 0, index: 0 });
  assert.equal(letter, 'a');
});
