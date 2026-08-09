import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError } from '../public/engine/game.js';
import { makeGame, tilesFor } from './helpers.js';

test('mutating a letter rescores the word and hands you the old letter', () => {
  const g = makeGame(['cat', 'cot'], {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['o', 'e', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const r = g.mutate({ playerId: 1, x: 1, y: 0, letter: 'o' });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cot');
  assert.equal(r.points, 5); // c3 + o1 + t1, no premium at (1,0)
  assert.ok(g.players[1].rack.includes('a'));
});

test('mutations that do not make a real word are rejected and reverted', () => {
  const g = makeGame(['cat'], {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['x', 'e', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.throws(() => g.mutate({ playerId: 1, x: 0, y: 0, letter: 'x' }), GameError);
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cat');
  assert.ok(g.players[1].rack.includes('x'));
});

test('a mutation must change the word and use a rack tile', () => {
  const g = makeGame(['cat', 'cot'], {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['e', 'e', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.throws(() => g.mutate({ playerId: 1, x: 1, y: 0, letter: 'a' }), GameError);
  assert.throws(() => g.mutate({ playerId: 1, x: 1, y: 0, letter: 'o' }), GameError); // no 'o'
});

test('mutating a shared cell validates both words through it', () => {
  const g = makeGame(['cat', 'cot', 'bat', 'bot'], {
    racks: [
      ['c', 'a', 't', 'b', 'e', 'e', 'e'],
      ['o', 't', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.place({
    playerId: 1,
    tiles: [
      { x: 0, y: 1, letter: 'o' },
      { x: 0, y: 2, letter: 't' },
    ],
  });
  const r = g.mutate({ playerId: 0, x: 0, y: 0, letter: 'b' });
  assert.deepEqual(r.words.sort(), ['bat', 'bot']);
});
