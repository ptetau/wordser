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
  const r = g2.swap({ playerId: 1, swaps: [{ x: 1, y: 0, letter: 'o' }] });
  assert.equal(g2.board.wordThrough(0, 0, 'h').word, 'cot');
  assert.equal(r.points, 0); // a swap is paid in letters, not points
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
  g.players[1].rack = ['d', 'o', 'g'];
  g.apply({
    type: 'swap',
    playerId: 1,
    swaps: [
      { x: 0, y: 0, letter: 'd' },
      { x: 1, y: 0, letter: 'o' },
      { x: 2, y: 0, letter: 'g' },
    ],
  });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'dog');
  assert.throws(() => g.apply({ type: 'dance', playerId: 1 }));
});

test('a clone owns its state: dry-running a move leaves the original alone', () => {
  const g = makeGame(['cat', 'cot'], {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['o', 'e', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  const dictionary = new Dictionary(['cat', 'cot']);

  // This is what the UI does on every keystroke to show the running score.
  const preview = Game.fromJSON(g.toJSON(), { dictionary });
  const shown = preview.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.ok(shown.points > 0);

  assert.deepEqual(g.players[0].scored, [], 'the dry run banked the word for real');
  assert.equal(g.spent.size, 0, 'the dry run burnt a premium for real');
  assert.equal(g.players[0].score, 0);
  assert.ok(!g.board.get(0, 0), 'the dry run wrote to the real board');

  // So the move actually played pays what the preview promised.
  const played = g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.equal(played.points, shown.points);
});

test('a clone owns a pending cherry choice', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.players[0].pendingChoice = ['q', 'r', 's'];
  const clone = Game.fromJSON(g.toJSON(), { dictionary: new Dictionary(['cat']) });
  clone.players[0].pendingChoice.pop();
  assert.equal(g.players[0].pendingChoice.length, 3);
});
