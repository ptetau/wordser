import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGame, tilesFor } from './helpers.js';

test('ending the day awards stars to the leaders and resets scores', () => {
  const g = makeGame(['cat']);
  g.players[0].score = 30;
  g.players[1].score = 12;
  const winners = g.startNewDay();
  assert.deepEqual(winners.map((w) => w.name), ['Ana']);
  assert.equal(g.players[0].stars, 1);
  assert.equal(g.players[1].stars, 0);
  assert.equal(g.players[0].score, 0);
  assert.equal(g.players[1].score, 0);
  assert.equal(g.day, 2);
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
  assert.equal(g.players[0].score, 15);

  nowMs += 24 * 60 * 60 * 1000;
  // New day: Ana may open it even though she played last, and yesterday's
  // star is hers.
  g.place({ playerId: 0, tiles: [{ x: 3, y: 0, letter: 's' }] });
  assert.equal(g.day, 2);
  assert.equal(g.players[0].stars, 1);
  assert.equal(g.players[0].score, 7); // only today's "cats" points (s on DL) remain
});
