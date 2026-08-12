import { test } from 'node:test';
import assert from 'node:assert/strict';
import { premiumAt } from '../public/engine/premium.js';
import { makeGame, tilesFor } from './helpers.js';

test('ending the day awards stars, resets scores, moves the star, deals racks', () => {
  const g = makeGame(['cat']);
  g.players[0].score = 30;
  g.players[1].score = 12;
  g.players[0].pendingChoice = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const winners = g.startNewDay();
  assert.deepEqual(winners.map((w) => w.name), ['Ana']);
  assert.equal(g.players[0].stars, 1);
  assert.equal(g.players[1].stars, 0);
  assert.equal(g.players[0].score, 0);
  assert.equal(g.players[1].score, 0);
  assert.equal(g.day, 2);
  // The start star wandered to a different double-word star...
  assert.notDeepEqual(g.startCell, { x: 0, y: 0 });
  assert.equal(g.startCell.x % 14, 0);
  assert.equal(g.startCell.y % 14, 0);
  assert.equal(premiumAt(g.startCell.x, g.startCell.y), 'DW'); // still a star
  // ...and everyone drew a completely fresh rack.
  assert.equal(g.players[0].rack.length, 7);
  assert.equal(g.players[1].rack.length, 7);
  assert.equal(g.players[0].pendingChoice, undefined);
});

test('a tie gives everyone at the top a star; a scoreless day gives none', () => {
  const g = makeGame(['cat']);
  g.players[0].score = 10;
  g.players[1].score = 10;
  assert.equal(g.startNewDay().length, 2);
  assert.equal(g.players[0].stars, 1);
  assert.equal(g.players[1].stars, 1);
  assert.equal(g.startNewDay().length, 0);
});

test('the day rolls over automatically with the clock', () => {
  let nowMs = Date.UTC(2026, 0, 1, 12);
  const g = makeGame(['cat', 'cats'], {
    racks: [['c', 'a', 't', 's', 'e', 'e', 'e'], []],
    now: () => nowMs,
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.equal(g.players[0].score, 10);

  nowMs += 24 * 60 * 60 * 1000;
  assert.equal(g.rolloverIfNeeded(), true);
  assert.equal(g.day, 2);
  assert.equal(g.players[0].stars, 1); // yesterday's star is hers
  assert.equal(g.players[0].score, 0);
  // A new day opens its own island; this test is about the clock, so keep
  // playing on yesterday's.
  g.islandCell = { x: 0, y: 0 };

  // Closing one day and opening the next is still two turns in a row, so
  // Ana has to wait for Ben even across the boundary.
  g.players[0].rack = ['s', 'e', 'e', 'e', 'e', 'e', 'e'];
  assert.throws(
    () => g.place({ playerId: 0, tiles: [{ x: 3, y: 0, letter: 's' }] }),
    /after a friend/,
  );
  g.players[1].rack = ['s', 'e', 'e', 'e', 'e', 'e', 'e'];
  g.place({ playerId: 1, tiles: [{ x: 3, y: 0, letter: 's' }] });
  assert.equal(g.players[1].score, 6); // only today's "cats" points
  assert.equal(g.players[0].score, 0);
});
