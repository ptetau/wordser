import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError } from '../public/engine/game.js';
import { makeGame } from './helpers.js';

function placeCatWithBlank(g) {
  g.place({
    playerId: 0,
    tiles: [
      { x: 0, y: 0, letter: 'c' },
      { x: 1, y: 0, letter: 'a', fromBlank: true },
      { x: 2, y: 0, letter: 't' },
    ],
  });
}

test('a blank plays as any letter and scores zero', () => {
  const g = makeGame(['cat'], { racks: [['c', '*', 't', 'e', 'e', 'e', 'e'], []] });
  placeCatWithBlank(g);
  // c on the DW start star, blank 0, t plain: (3+0+1) * 2
  assert.equal(g.players[0].score, 8);
  assert.equal(g.board.get(1, 0).isBlank, true);
});

test('a wildcard can be redefined to fit your word if all words stay real', () => {
  const g = makeGame(['cat', 'cot', 'dog'], {
    racks: [
      ['c', '*', 't', 'e', 'e', 'e', 'e'],
      ['d', 'g', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  placeCatWithBlank(g);
  const r = g.place({
    playerId: 1,
    tiles: [
      { x: 1, y: -1, letter: 'd' },
      { x: 1, y: 1, letter: 'g' },
    ],
    redefinitions: [{ x: 1, y: 0, as: 'o' }],
  });
  assert.deepEqual(r.words, ['dog']);
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cot');
  // no premiums under d or g (odd cells are always plain): 2+0+2
  assert.equal(r.points, 4);
});

test('a redefinition that breaks an existing word is rejected', () => {
  const g = makeGame(['cat', 'dog'], {
    racks: [
      ['c', '*', 't', 'e', 'e', 'e', 'e'],
      ['d', 'g', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  placeCatWithBlank(g);
  // "dog" fits vertically, but redefining the blank to 'o' makes "cot",
  // which this dictionary doesn't contain.
  assert.throws(
    () =>
      g.place({
        playerId: 1,
        tiles: [
          { x: 1, y: -1, letter: 'd' },
          { x: 1, y: 1, letter: 'g' },
        ],
        redefinitions: [{ x: 1, y: 0, as: 'o' }],
      }),
    GameError,
  );
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cat');
  assert.equal(g.board.get(1, -1), null);
});

test('only wildcards your word touches can be redefined', () => {
  const g = makeGame(['cat', 'cot', 'at'], {
    racks: [
      ['c', '*', 't', 'e', 'e', 'e', 'e'],
      ['a', 't', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  placeCatWithBlank(g);
  // A word placed elsewhere may not opportunistically rewrite a distant blank.
  assert.throws(
    () =>
      g.place({
        playerId: 1,
        tiles: [
          { x: 2, y: 1, letter: 'a' },
          { x: 2, y: 2, letter: 't' },
        ],
        redefinitions: [{ x: 1, y: 0, as: 'o' }],
      }),
    GameError,
  );
});

test('normal tiles cannot be redefined', () => {
  const g = makeGame(['cat', 'ta'], {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['a', 'e', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  g.place({
    playerId: 0,
    tiles: [
      { x: 0, y: 0, letter: 'c' },
      { x: 1, y: 0, letter: 'a' },
      { x: 2, y: 0, letter: 't' },
    ],
  });
  assert.throws(
    () =>
      g.place({
        playerId: 1,
        tiles: [{ x: 2, y: 1, letter: 'a' }],
        redefinitions: [{ x: 1, y: 0, as: 'o' }],
      }),
    GameError,
  );
});
