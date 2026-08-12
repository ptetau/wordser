import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError, RACK_MAX } from '../public/engine/game.js';
import { makeGame, tilesFor } from './helpers.js';

// Two moves write over letters already down, and they are each other's
// opposite: a swap takes the letters and scores nothing, a stack scores the
// words and posts the letters back into the bag. Both reach as far as you
// like in one turn, so long as everything stays real and every letter after
// the first lands in a word the reach already touches.

function withCat(words, ben) {
  const g = makeGame(['cat', ...words], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ben],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  return g;
}

test('a swap takes the letter, scores nothing, and takes the turn', () => {
  const g = withCat(['cot'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']);
  const size = g.players[1].rack.length;
  const r = g.swap({ playerId: 1, swaps: [{ x: 1, y: 0, letter: 'o' }] });

  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cot');
  assert.equal(r.points, 0, 'a swap is paid in letters, not points');
  assert.deepEqual(r.took, ['a']);
  assert.ok(g.players[1].rack.includes('a'));
  assert.equal(g.players[1].rack.length, size, 'one out, one in');
  assert.equal(g.players[1].score, 0);
  assert.equal(g.lastPlayerId, 1, 'a swap is a turn');
  assert.equal(g.isTheirTurn(1), false);
});

test('two swaps in one move, along the one word', () => {
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
  assert.equal(r.points, 0);
  assert.deepEqual(r.took.sort(), ['a', 'c']);
});

test('a stack scores its words and gives the letters up to the bag', () => {
  const g = withCat(['cot'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']);
  const pool = g.bag.pool.length;
  const r = g.stack({ playerId: 1, stacks: [{ x: 1, y: 0, letter: 'o' }] });

  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cot');
  assert.equal(r.points, 5, 'c3 + o1 + t1, no premium on a spent square');
  assert.deepEqual(r.gave, ['a'], 'the A is gone, not kept');
  assert.equal(g.players[1].score, 5);
  assert.equal(g.players[1].rack.filter((l) => l === 'a').length, 0);
  // One tile out of the rack, one A into the bag, one drawn back: the bag is
  // where the difference shows up.
  assert.equal(g.bag.pool.length, pool, 'the A went back for somebody else');
  assert.equal(g.lastPlayerId, 1);
});

test('a stack pays for a word once a day, like any other play', () => {
  const g = makeGame(['cat', 'cot', 'cut'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['o', 'u', 'a', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const stackAt = (letter) => {
    g.lastPlayerId = null;
    g.players[1].rack = [letter, 'e', 'e', 'e', 'e', 'e', 'e'];
    return g.stack({ playerId: 1, stacks: [{ x: 1, y: 0, letter }] });
  };
  assert.equal(stackAt('o').points, 5);
  assert.equal(stackAt('u').points, 5);
  const again = stackAt('o');
  assert.equal(again.points, 0, 'COT was scored earlier today');
  assert.deepEqual(again.repeats, ['cot']);
});

test('a stack counts towards the finish line', () => {
  const g = withCat(['cot'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']);
  g.setGoal({ playerId: 0, words: 2 });
  const r = g.stack({ playerId: 1, stacks: [{ x: 1, y: 0, letter: 'o' }] });
  assert.equal(r.wordsPlayed, 2);
  assert.ok(r.finished, 'the second word ended it');
  assert.deepEqual(g.over.winners, ['Ana'], 'CAT on the star beat the stack');
});

test('a swap is not a word played', () => {
  const g = withCat(['cot'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']);
  g.setGoal({ playerId: 0, words: 2 });
  g.swap({ playerId: 1, swaps: [{ x: 1, y: 0, letter: 'o' }] });
  assert.equal(g.wordsPlayed, 1);
  assert.equal(g.over, null);
});

test('every letter after the first must land in a word the reach touches', () => {
  // CAT across the star with COT hanging off its C. The two Ts — one at the
  // end of each word — are neighbours on the board but share no word, so
  // one turn cannot reach from one to the other.
  const g = makeGame(['cat', 'cot', 'car', 'cob'], {
    racks: [['c', 'a', 't', 'o', 't', 'e', 'e'], ['r', 'b', 'e', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.lastPlayerId = null;
  g.place({ playerId: 0, tiles: [{ x: 0, y: 1, letter: 'o' }, { x: 0, y: 2, letter: 't' }] });
  for (const type of ['swap', 'stack']) {
    assert.throws(
      () => g.apply({
        type, playerId: 1,
        [type === 'swap' ? 'swaps' : 'stacks']: [
          { x: 2, y: 0, letter: 'r' }, // CAT -> CAR
          { x: 0, y: 2, letter: 'b' }, // COT -> COB, a word away
        ],
      }),
      /the others already touch/,
    );
  }
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cat', 'and nothing moved');
});

test('a reach follows a crossing word from one letter to the next', () => {
  // CAT across, TOT hanging down off its T. Swapping the shared T and then
  // the O below it is one reach: TOT runs through both.
  const g = makeGame(['cat', 'car', 'tot', 'rat', 'rot'], {
    racks: [['c', 'a', 't', 'o', 't', 'e', 'e'], ['r', 'a', 'e', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.lastPlayerId = null;
  g.place({ playerId: 0, tiles: [{ x: 2, y: 1, letter: 'o' }, { x: 2, y: 2, letter: 't' }] });
  const r = g.swap({
    playerId: 1,
    swaps: [
      { x: 2, y: 0, letter: 'r' }, // CAT -> CAR, TOT -> ROT
      { x: 2, y: 1, letter: 'a' }, // ROT -> RAT, reached through ROT
    ],
  });
  assert.deepEqual(r.words.sort(), ['car', 'rat']);
  assert.deepEqual(r.took.sort(), ['o', 't']);
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
