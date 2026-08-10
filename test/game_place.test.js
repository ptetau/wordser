import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError } from '../public/engine/game.js';
import { makeGame, tilesFor } from './helpers.js';

test('first word scores with criss-cross premiums', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  const r = g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  // c on the DW start star at (0,0): (3+1+1) * 2
  assert.equal(r.points, 10);
  assert.equal(g.players[0].score, 10);
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cat');
  assert.equal(g.players[0].rack.length, 7); // refilled
});

test('the first word must cover the start cell', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  assert.throws(() => g.place({ playerId: 0, tiles: tilesFor('cat', 3, 3) }), /start cell/);
  assert.equal(g.board.isEmpty(), true);
  // Covering the origin anywhere in the word is enough.
  g.place({ playerId: 0, tiles: tilesFor('cat', -2, 0) });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cat');
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

test('not even a lone player may take two turns in a row', () => {
  const g = makeGame(['cat', 'cats'], {
    players: ['Solo'],
    racks: [['c', 'a', 't', 's', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.throws(
    () => g.place({ playerId: 0, tiles: [{ x: 3, y: 0, letter: 's' }] }),
    /add a friend or a CPU/,
  );
  // Somebody else taking a turn — even a CPU passing — frees them again.
  const cpu = g.addCpu();
  g.pass({ playerId: cpu.id });
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
  // Only the DW start star at the origin: (1+3+3+2+1+4+2) * 2, plus 50 bingo.
  assert.equal(r.points, 16 * 2 + 50);
});
