import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameError, DAY_END_VOTE_MS } from '../public/engine/game.js';
import { Game } from '../public/engine/game.js';
import { Dictionary } from '../public/engine/dictionary.js';
import { makeGame, tilesFor } from './helpers.js';

test('proposing needs an empty bag; a lone player ends the day at once', () => {
  const g = makeGame(['cat'], { players: ['Solo'] });
  assert.throws(() => g.proposeDayEnd({ playerId: 0 }), /bag/);
  g.bag.pool = [];
  const r = g.proposeDayEnd({ playerId: 0 });
  assert.equal(r.dayEnded, true);
  assert.equal(g.day, 2);
  assert.equal(g.dayEndVote, null);
});

test('everyone agreeing ends the day immediately', () => {
  const g = makeGame(['cat'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.players[0].score = 12;
  g.bag.pool = [];
  const r1 = g.proposeDayEnd({ playerId: 0 });
  assert.equal(r1.proposed, true);
  assert.ok(g.dayEndVote.agreed.includes(0));
  const r2 = g.voteDayEnd({ playerId: 1, agree: true });
  assert.equal(r2.dayEnded, true);
  assert.equal(g.day, 2);
  assert.equal(g.players[0].stars, 1);
});

test('any player can cancel, and playing letters cancels too', () => {
  const g = makeGame(['cat', 'cot'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.bag.pool = [];
  g.proposeDayEnd({ playerId: 0 });
  const r = g.voteDayEnd({ playerId: 1, agree: false });
  assert.equal(r.cancelled, true);
  assert.equal(g.dayEndVote, null);
  assert.equal(g.day, 1);
  // Propose again; this time player 1 simply plays on — same effect.
  g.proposeDayEnd({ playerId: 0 });
  g.players[1].rack = ['o', 't'];
  g.place({
    playerId: 1,
    tiles: [
      { x: 0, y: 1, letter: 'o' },
      { x: 0, y: 2, letter: 't' },
    ],
  });
  assert.equal(g.dayEndVote, null);
  assert.equal(g.day, 1);
  // Passing, though, leaves the proposal running.
  g.proposeDayEnd({ playerId: 1 });
  g.pass({ playerId: 0 });
  assert.ok(g.dayEndVote);
});

test('the two-minute timer ends the day when nobody objects', () => {
  let nowMs = Date.UTC(2026, 0, 1, 12);
  const g = makeGame(['cat'], { now: () => nowMs });
  g.bag.pool = [];
  g.proposeDayEnd({ playerId: 0 });
  nowMs += DAY_END_VOTE_MS - 1000;
  assert.equal(g.tickClock(), false); // still ticking
  assert.equal(g.day, 1);
  nowMs += 2000;
  assert.equal(g.tickClock(), true);
  assert.equal(g.day, 2);
  assert.equal(g.dayEndVote, null);
});

test('an expired vote resolves before the next move is processed', () => {
  let nowMs = Date.UTC(2026, 0, 1, 12);
  const g = makeGame(['cat'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []],
    now: () => nowMs,
  });
  g.bag.pool = [];
  g.proposeDayEnd({ playerId: 0 });
  nowMs += DAY_END_VOTE_MS + 1;
  // The expired vote resolves inside the next call, dealing day 2's racks;
  // rig the rack after that and open the new day.
  assert.equal(g.tickClock(), true);
  g.players[0].rack = ['c', 'a', 't'];
  g.place({ playerId: 0, tiles: tilesFor('cat', g.startCell.x, g.startCell.y) });
  assert.equal(g.day, 2);
});

test('CPU players agree automatically', () => {
  const g = makeGame(['cat'], { players: ['Pat'] });
  const cpu = g.addPlayer('Robo 🤖');
  cpu.isCpu = true;
  g.bag.pool = [];
  const r = g.proposeDayEnd({ playerId: 0 });
  assert.equal(r.dayEnded, true); // Pat + auto-agreeing CPU = everyone
});

test('a live vote survives serialization', () => {
  let nowMs = Date.UTC(2026, 0, 1, 12);
  const g = makeGame(['cat'], { now: () => nowMs });
  g.bag.pool = [];
  g.proposeDayEnd({ playerId: 0 });
  const g2 = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), {
    dictionary: new Dictionary(['cat']),
    now: () => nowMs,
  });
  assert.equal(g2.dayEndVote.proposer, 0);
  assert.deepEqual(g2.dayEndVote.agreed, [0]);
  const r = g2.voteDayEnd({ playerId: 1, agree: true });
  assert.equal(r.dayEnded, true);
});
