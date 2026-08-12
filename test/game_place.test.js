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
  // DW start star under the A, and a DL under the E four along:
  // (1+3+3+2+1+4+2 letters = 16, +1 for the doubled E) * 2 for the star,
  // doubled again for laying out the whole rack, then 50 flat for the bingo.
  assert.equal(r.points, 17 * 2 * 2 + 50);
  assert.equal(r.emptied, true);
  assert.match(g.log.join('\n'), /the whole tray, doubled/);
});

test('the tray bonus wants a full tray emptied, not just a tidy one', () => {
  // Six tiles in hand, all six played: a clean sweep, but not a full rack.
  const g = makeGame(['abcdef'], { racks: [['a', 'b', 'c', 'd', 'e', 'f'], []] });
  const r = g.place({ playerId: 0, tiles: tilesFor('abcdef', 0, 0) });
  assert.equal(r.emptied, false);
  // 1+3+3+2+1+4 = 14, +1 for the DL under the E, doubled by the star.
  assert.equal(r.points, 15 * 2, 'the star doubles it, nothing else');
});

test('a full rack that leaves something behind is not a sweep either', () => {
  const g = makeGame(['abcdef'], { racks: [['a', 'b', 'c', 'd', 'e', 'f', 'z'], []] });
  const r = g.place({ playerId: 0, tiles: tilesFor('abcdef', 0, 0) });
  assert.equal(r.emptied, false, 'the Z is still in hand');
});

// ------------------------------------------- writing over as you play

test('a word can be laid straight over letters already down', () => {
  // MEN in the middle of the board; HU_A_ turns it into HUMAN, reusing the
  // M and the N and writing the A over the E.
  const g = makeGame(['men', 'human'], {
    racks: [['m', 'e', 'n', 'x', 'x', 'x', 'x'], ['h', 'u', 'a', 'x', 'x', 'x', 'x']],
  });
  g.place({ playerId: 0, tiles: tilesFor('men', 0, 0) });
  const bagBefore = g.bag.pool.length;

  const r = g.place({
    playerId: 1,
    tiles: [
      { x: -2, y: 0, letter: 'h' },
      { x: -1, y: 0, letter: 'u' },
      { x: 1, y: 0, letter: 'a' }, // over the E
    ],
  });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'human');
  assert.deepEqual(r.words, ['human']);
  assert.deepEqual(r.gave, ['e'], 'the E went back into the bag');
  assert.equal(g.bag.pool.length, bagBefore + 1 - 3, 'the E in, three drawn to refill');
  // The ★'s double-word was collected by MEN and is gone; H and U land on
  // plain board, so the word pays flat.
  assert.equal(r.points, 4 + 1 + 3 + 1 + 1, 'h4 u1 m3 a1 n1');
});

test('a placement still needs fresh ground, and never writes a letter over itself', () => {
  const g = makeGame(['men', 'human', 'mean'], {
    racks: [['m', 'e', 'n', 'x', 'x', 'x', 'x'], ['m', 'e', 'n', 'a', 'x', 'x', 'x']],
  });
  g.place({ playerId: 0, tiles: tilesFor('men', 0, 0) });
  assert.throws(
    () => g.place({ playerId: 1, tiles: [{ x: 0, y: 0, letter: 'm' }] }),
    /already there/,
  );
  assert.throws(
    () => g.place({
      playerId: 1,
      tiles: [{ x: 0, y: 0, letter: 'e' }, { x: 1, y: 0, letter: 'm' }],
    }),
    /at least one letter on empty ground/,
  );
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'men', 'and nothing moved');
});

test('a word written over a word that will not stand is refused whole', () => {
  const g = makeGame(['men', 'ah', 'human'], {
    racks: [['m', 'e', 'n', 'x', 'x', 'x', 'x'], ['h', 'u', 'z', 'x', 'x', 'x', 'x']],
  });
  g.place({ playerId: 0, tiles: tilesFor('men', 0, 0) });
  assert.throws(
    () => g.place({
      playerId: 1,
      tiles: [
        { x: -2, y: 0, letter: 'h' },
        { x: -1, y: 0, letter: 'u' },
        { x: 1, y: 0, letter: 'z' }, // HUMZN
      ],
    }),
    /not a real word/,
  );
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'men', 'the E is back where it was');
  assert.equal(g.players[1].rack.filter((l) => l === 'z').length, 1);
});
