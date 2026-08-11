import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError, RACK_MAX } from '../public/engine/game.js';
import { makeGame, tilesFor } from './helpers.js';

// One move handles every trade with the board: swap as many letters as you
// like, from as many words as you like, so long as everything stays real.

function withCat(words, ben) {
  const g = makeGame(['cat', ...words], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ben],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  return g;
}

test('a single swap pays the tile and takes the turn', () => {
  const g = withCat(['cot'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']);
  const size = g.players[1].rack.length;
  const r = g.swap({ playerId: 1, swaps: [{ x: 1, y: 0, letter: 'o' }] });

  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cot');
  assert.equal(r.points, 1 + 1); // the O is worth 1, plus 1×1 for the combination
  assert.equal(r.bonus, 1);
  assert.deepEqual(r.took, ['a']);
  assert.ok(g.players[1].rack.includes('a'));
  assert.equal(g.players[1].rack.length, size, 'one out, one in');
  assert.equal(g.players[1].score, r.points);
  assert.equal(g.lastPlayerId, 1, 'a swap is a turn now');
  assert.equal(g.isTheirTurn(1), false);
});

test('two swaps in one move, across two words', () => {
  const g = makeGame(['cat', 'cot', 'oat', 'oot'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['o', 'o', 'e', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const r = g.swap({
    playerId: 1,
    swaps: [
      { x: 0, y: 0, letter: 'o' }, // CAT -> OAT
      { x: 1, y: 0, letter: 'o' }, // OAT -> OOT
    ],
  });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'oot');
  assert.equal(r.bonus, 4, 'two letters, each worth two');
  assert.equal(r.points, 1 + 1 + 4);
  assert.deepEqual(r.took.sort(), ['a', 'c']);
});

test('a swap that leaves a word unreal is refused, and the board is untouched', () => {
  const g = withCat(['cot'], ['x', 'e', 'e', 'e', 'e', 'e', 'e']);
  assert.throws(() => g.swap({ playerId: 1, swaps: [{ x: 0, y: 0, letter: 'x' }] }), GameError);
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cat');
  assert.ok(g.players[1].rack.includes('x'));
  assert.equal(g.players[1].score, 0);
});

test('one bad swap in a batch rolls the whole batch back', () => {
  const g = makeGame(['cat', 'cot', 'oat'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['o', 'x', 'e', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.throws(
    () => g.swap({
      playerId: 1,
      swaps: [{ x: 0, y: 0, letter: 'o' }, { x: 2, y: 0, letter: 'x' }],
    }),
    GameError,
  );
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cat');
  assert.deepEqual(g.players[1].rack.slice(0, 2), ['o', 'x'], 'the rack is untouched too');
});

test('a swap must change something, and must be paid for from the rack', () => {
  const g = withCat(['cot'], ['e', 'e', 'e', 'e', 'e', 'e', 'e']);
  assert.throws(() => g.swap({ playerId: 1, swaps: [{ x: 1, y: 0, letter: 'a' }] }), /changes nothing/);
  assert.throws(() => g.swap({ playerId: 1, swaps: [{ x: 1, y: 0, letter: 'o' }] }), /no "o"/);
  assert.throws(() => g.swap({ playerId: 1, swaps: [] }), /at least one/);
  assert.throws(
    () => g.swap({ playerId: 1, swaps: [{ x: 9, y: 9, letter: 'e' }] }),
    /no tile at/,
  );
});

test('the same cell cannot be swapped twice in one move', () => {
  const g = withCat(['cot', 'cut'], ['o', 'u', 'e', 'e', 'e', 'e', 'e']);
  assert.throws(
    () => g.swap({
      playerId: 1,
      swaps: [{ x: 1, y: 0, letter: 'o' }, { x: 1, y: 0, letter: 'u' }],
    }),
    /only swap a cell once/,
  );
});

test('a swap validates every word through the cell, not just the obvious one', () => {
  const g = makeGame(['cat', 'cot', 'bat', 'bot'], {
    racks: [['c', 'a', 't', 'b', 'e', 'e', 'e'], ['o', 't', 'e', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.place({
    playerId: 1,
    tiles: [{ x: 0, y: 1, letter: 'o' }, { x: 0, y: 2, letter: 't' }],
  });
  const r = g.swap({ playerId: 0, swaps: [{ x: 0, y: 0, letter: 'b' }] });
  assert.deepEqual(r.words.sort(), ['bat', 'bot']);
});

test('a swap never overflows the rack', () => {
  const g = withCat(['cot'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']);
  g.players[1].rack = ['o', ...Array(RACK_MAX - 1).fill('e')];
  g.swap({ playerId: 1, swaps: [{ x: 1, y: 0, letter: 'o' }] });
  assert.equal(g.players[1].rack.length, RACK_MAX, 'one out, one in, always');
});
