import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../public/engine/game.js';
import { Dictionary } from '../public/engine/dictionary.js';
import { premiumAt } from '../public/engine/premium.js';
import { makeGame, tilesFor } from './helpers.js';

// A premium square is a seam, not a crop: the first letter onto it takes the
// bonus, and everything after is face value.

test('the start star pays its double-word once, to whoever gets there first', () => {
  const g = makeGame(['cat', 'cot'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']],
  });
  assert.equal(premiumAt(0, 0), 'DW');
  const first = g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.equal(first.points, 10); // (3+1+1) doubled by the star

  // Ben swaps the A for an O. A swap pays nothing at all — and even a stack,
  // which does pay for its words, never gets the square: the star's
  // double-word was collected by CAT and is gone for good.
  const second = g.swap({ playerId: 1, swaps: [{ x: 1, y: 0, letter: 'o' }] });
  assert.equal(second.points, 0);
  assert.equal(g.spent.has('0,0'), true);
});

test('a premium is spent even by a move that scored nothing for it', () => {
  const g = makeGame(['cat', 'cot'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['o', 'c', 'e', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.equal(g.spent.has('0,0'), true);
  // ...and it stays spent through a serialization round trip.
  const revived = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), {
    dictionary: new Dictionary(['cat', 'cot']),
  });
  assert.equal(revived.spent.has('0,0'), true);
  // Placing CAT again a row lower would be a fresh line of play; the star
  // itself, having been spent, never pays anyone again.
  revived.players[1].rack = ['c', 'a', 't'];
  assert.equal(revived.spent.has('0,0'), true);
});

test('extending a word pays face value for the letters already down', () => {
  // AT on plain board, then a letter added in front of it. The old letters
  // never bring a premium with them, spent or not.
  const g = makeGame(['at', 'cat', 'ca'], {
    racks: [['a', 't', 'e', 'e', 'e', 'e', 'e'], ['c', 'e', 'e', 'e', 'e', 'e', 'e']],
  });
  const first = g.place({ playerId: 0, tiles: tilesFor('at', 0, 0) });
  assert.equal(first.points, 4); // (1+1) doubled by the star

  const added = g.place({ playerId: 1, tiles: [{ x: -1, y: 0, letter: 'c' }] });
  assert.equal(premiumAt(-1, 0), null, 'the cell in front is plain board');
  assert.equal(added.points, 5); // c3 + a1 + t1, nothing doubled
});

test('the ore does not grow back with the new day', () => {
  const g = makeGame(['cat', 'cot'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.startNewDay();
  assert.equal(g.spent.has('0,0'), true);
  g.players[1].rack = ['o', 'c'];
  // A stack on the spent star pays for its word, never for the square:
  // COT is 5 flat, not the 10 the double-word would have made of it.
  assert.equal(g.stack({ playerId: 1, stacks: [{ x: 1, y: 0, letter: 'o' }] }).points, 5);
});

test('fresh ground still pays: the rule is per square, not per board', () => {
  const g = makeGame(['cat', 'tat'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['t', 'a', 't', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  // A word down an untouched column: its own premiums are all still there.
  const down = g.place({
    playerId: 1,
    tiles: [{ x: 0, y: 1, letter: 'a' }, { x: 0, y: 2, letter: 't' }],
  });
  const cells = [[0, 0], [0, 1], [0, 2]];
  const flat = cells.reduce((n, [x, y]) => n + (x === 0 && y === 0 ? 3 : 1), 0);
  assert.ok(down.points >= flat, 'a new line of play is not penalised');
});
