import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError, RACK_MAX } from '../public/engine/game.js';
import { makeGame, tilesFor } from './helpers.js';

function withCat(words, ben) {
  const g = makeGame(['cat', ...words], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ben],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  return g;
}

test('same-length steal: reuse nothing, pocket the old letters', () => {
  const g = withCat(['dog'], ['d', 'o', 'g', 'e', 'e', 'e', 'e']);
  const r = g.stealReplace({ playerId: 1, x: 0, y: 0, dir: 'h', word: 'dog' });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'dog');
  // d on the DW start star at (0,0): (2+1+2) * 2
  assert.equal(r.points, 10);
  assert.equal(r.stolen, 3);
  for (const l of ['c', 'a', 't']) assert.ok(g.players[1].rack.includes(l));
});

test('rearranging the same letters is a valid steal that uses no rack tiles', () => {
  const g = withCat(['act'], ['e', 'e', 'e', 'e', 'e', 'e', 'e']);
  const rackBefore = [...g.players[1].rack];
  const r = g.stealReplace({ playerId: 1, x: 1, y: 0, dir: 'h', word: 'act' });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'act');
  assert.equal(r.stolen, 0);
  assert.deepEqual(g.players[1].rack, rackBefore);
});

test('steals that break a crossing word are rejected and reverted', () => {
  const g = makeGame(['cat', 'cot', 'mat'], {
    racks: [
      ['c', 'a', 't', 'm', 'e', 'e', 'e'],
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
  // "mat" would turn vertical "cot" into "mot": not a word here.
  assert.throws(
    () => g.stealReplace({ playerId: 0, x: 0, y: 0, dir: 'h', word: 'mat' }),
    GameError,
  );
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cat');
  assert.equal(g.board.wordThrough(0, 0, 'v').word, 'cot');
});

test('shorter steal: take a long word down, steal up to the cap, discard the rest', () => {
  const g = makeGame(['planets', 'pan'], {
    racks: [
      ['p', 'l', 'a', 'n', 'e', 't', 's'],
      ['e', 'e', 'e', 'e', 'e', 'e', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  g.place({ playerId: 0, tiles: tilesFor('planets', 0, 0) });
  const r = g.stealReplace({ playerId: 1, x: 0, y: 0, dir: 'h', word: 'pan' });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'pan');
  assert.equal(g.board.get(4, 0), null); // vacated
  // Old letters l,e,t,s left over; rack had 11 of max 12: 1 stolen, 3 discarded.
  assert.equal(r.stolen, 1);
  assert.equal(r.discarded, 3);
  assert.equal(g.players[1].rack.length, RACK_MAX);
});

test('longer steal: grow a word using stolen and rack letters', () => {
  const g = withCat(['cart'], ['r', 'e', 'e', 'e', 'e', 'e', 'e']);
  const r = g.stealReplace({ playerId: 1, x: 0, y: 0, dir: 'h', word: 'cart' });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cart');
  // Old 'a' is reused, old 't' moves to the end, 'r' comes from the rack.
  assert.equal(r.stolen, 0);
});

test('the replacement must be a real, different word that overlaps', () => {
  const g = withCat(['dog', 'ta'], ['d', 'o', 'g', 't', 'a', 'e', 'e']);
  assert.throws(
    () => g.stealReplace({ playerId: 1, x: 0, y: 0, dir: 'h', word: 'cat' }),
    GameError,
  );
  assert.throws(
    () => g.stealReplace({ playerId: 1, x: 0, y: 0, dir: 'h', word: 'zzz' }),
    GameError,
  );
  assert.throws(
    () => g.stealReplace({ playerId: 1, x: 0, y: 0, dir: 'h', word: 'ta', offset: 5 }),
    GameError,
  );
});
