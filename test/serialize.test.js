import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../public/engine/game.js';
import { Dictionary } from '../public/engine/dictionary.js';
import { makeGame, tilesFor } from './helpers.js';

test('toJSON/fromJSON round-trips a game in progress', () => {
  const g = makeGame(['cat', 'cot', 'dog'], {
    racks: [
      ['c', '*', 't', 'e', 'e', 'e', 'e'],
      ['o', 'e', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  g.place({
    playerId: 0,
    tiles: [
      { x: 0, y: 0, letter: 'c' },
      { x: 1, y: 0, letter: 'a', fromBlank: true },
      { x: 2, y: 0, letter: 't' },
    ],
  });

  const snapshot = JSON.parse(JSON.stringify(g.toJSON()));
  const g2 = Game.fromJSON(snapshot, { dictionary: new Dictionary(['cat', 'cot', 'dog']) });

  assert.equal(g2.board.wordThrough(0, 0, 'h').word, 'cat');
  assert.equal(g2.board.get(1, 0).isBlank, true);
  assert.equal(g2.players[0].score, g.players[0].score);
  assert.equal(g2.lastPlayerId, 0);
  assert.equal(g2.lastMove.playerId, 0);
  assert.deepEqual([...g2.lastMove.keys].sort(), ['0,0', '1,0', '2,0']);
  assert.deepEqual(g2.startCell, g.startCell);

  // The revived game keeps playing by the same rules.
  const r = g2.mutate({ playerId: 1, x: 1, y: 0, letter: 'o' });
  assert.equal(g2.board.wordThrough(0, 0, 'h').word, 'cot');
  assert.ok(r.points > 0);
  // The ousted tile was the wildcard.
  assert.ok(g2.players[1].rack.includes('*'));
});

test('apply dispatches plain-data moves', () => {
  const g = makeGame(['cat', 'dog', 'dag'], {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['d', 'o', 'g', 'e', 'e', 'e', 'e'],
    ],
  });
  g.apply({ type: 'place', playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.apply({ type: 'steal', playerId: 1, x: 0, y: 0, dir: 'h', word: 'dog' });
  g.players[0].rack = ['a'];
  g.apply({ type: 'mutate', playerId: 0, x: 1, y: 0, letter: 'a' });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'dag');
  assert.throws(() => g.apply({ type: 'dance', playerId: 1 }));
});
