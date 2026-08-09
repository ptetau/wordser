import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError } from '../public/engine/game.js';
import { makeGame, tilesFor } from './helpers.js';

test('first word scores with criss-cross premiums', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  const r = g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  // c on TW at (0,0), no other premiums on the row: (3+1+1) * 3
  assert.equal(r.points, 15);
  assert.equal(g.players[0].score, 15);
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cat');
  assert.equal(g.players[0].rack.length, 7); // refilled
});

test('you can only play after a friend has played', () => {
  const g = makeGame(['cat', 'cats'], { racks: [['c', 'a', 't', 's', 'e', 'e', 'e'], ['s']] });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.throws(
    () => g.place({ playerId: 0, tiles: [{ x: 3, y: 0, letter: 's' }] }),
    GameError,
  );
  g.place({ playerId: 1, tiles: [{ x: 3, y: 0, letter: 's' }] });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cats');
});

test('a single player may play freely', () => {
  const g = makeGame(['cat', 'cats'], {
    players: ['Solo'],
    racks: [['c', 'a', 't', 's', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.place({ playerId: 0, tiles: [{ x: 3, y: 0, letter: 's' }] });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cats');
});

test('invalid words are rejected and the board reverts', () => {
  const g = makeGame(['cat'], { racks: [['z', 'q', 'e', 'e', 'e', 'e', 'e'], []] });
  assert.throws(() => g.place({ playerId: 0, tiles: tilesFor('zq', 0, 0) }), GameError);
  assert.equal(g.board.isEmpty(), true);
  assert.equal(g.players[0].score, 0);
  assert.equal(g.players[0].rack.length, 7);
});

test('placements must connect to the board and leave no gaps', () => {
  const g = makeGame(['cat', 'at'], {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['a', 't', 'a', 't', 'e', 'e', 'e'],
    ],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  // Floating word far away.
  assert.throws(() => g.place({ playerId: 1, tiles: tilesFor('at', 50, 50) }), GameError);
  // Gap in the middle of a line.
  assert.throws(
    () =>
      g.place({
        playerId: 1,
        tiles: [
          { x: 0, y: 1, letter: 'a' },
          { x: 0, y: 3, letter: 't' },
        ],
      }),
    GameError,
  );
});

test('cross-words are validated', () => {
  const g = makeGame(['cat', 'ta'], {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['x', 'a', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  // 'x' under the 'c' would make vertical "cx": not a word.
  assert.throws(() => g.place({ playerId: 1, tiles: [{ x: 0, y: 1, letter: 'x' }] }), GameError);
  // 'a' under the 't' makes vertical "ta": fine.
  const r = g.place({ playerId: 1, tiles: [{ x: 2, y: 1, letter: 'a' }] });
  assert.deepEqual(r.words, ['ta']);
});

test('placing seven or more tiles earns the bingo bonus', () => {
  const g = makeGame(['abcdefg'], {
    racks: [['a', 'b', 'c', 'd', 'e', 'f', 'g'], []],
  });
  const r = g.place({ playerId: 0, tiles: tilesFor('abcdefg', 0, 0) });
  // TW at origin, DL under the d at (3,0): (1+3+3+4+1+4+2) * 3, plus 50 bingo.
  assert.equal(r.points, 18 * 3 + 50);
});
