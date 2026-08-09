import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWordList, takeCpuTurn } from '../public/cpu.js';
import { Dictionary } from '../public/engine/dictionary.js';
import { mulberry32 } from '../public/engine/tiles.js';
import { makeGame, tilesFor } from './helpers.js';

const DICT = ['cat', 'at', 'ta', 'tap', 'pat', 'apt', 'cap'];

test('the CPU opens on the start cell and then plays through board letters', () => {
  const g = makeGame(DICT, {
    racks: [
      ['c', 'a', 't', 'p', 'a', 't', 'a'],
      ['c', 'a', 't', 'p', 'a', 't', 'a'],
    ],
  });
  const words = buildWordList(new Dictionary(DICT));
  const rng = mulberry32(7);

  const first = takeCpuTurn(g, 0, words, rng);
  assert.ok(first, 'CPU should find an opening move');
  assert.equal(g.lastPlayerId, 0);
  assert.ok(g.players[0].score > 0);

  const second = takeCpuTurn(g, 1, words, rng);
  assert.ok(second, 'CPU should find an anchored move');
  assert.equal(g.lastPlayerId, 1);
  assert.ok(g.board.allWords().length >= 2);
});

test('the CPU respects the friend rule and exchanges when stuck', () => {
  const g = makeGame(DICT, {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['z', 'z', 'z', 'z', 'z', 'z', 'z'],
    ],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const words = buildWordList(new Dictionary(DICT));
  // Player 0 just moved: a CPU in seat 0 may not even exchange.
  assert.equal(takeCpuTurn(g, 0, words, mulberry32(1)), null);
  // A rack of z's can't form anything here — the CPU swaps it instead.
  const r = takeCpuTurn(g, 1, words, mulberry32(1));
  assert.equal(r.exchanged, 7);
  assert.ok(!g.players[1].rack.every((l) => l === 'z'));
  // When the bag can't cover an exchange either, the CPU reports stuck.
  g.lastPlayerId = null;
  g.bag.pool = [];
  g.players[1].rack = ['z', 'z', 'z', 'z', 'z', 'z', 'z'];
  assert.equal(takeCpuTurn(g, 1, words, mulberry32(1)), null);
});

test('the CPU resolves a cherry by keeping the most valuable letter', () => {
  const g = makeGame(DICT, { racks: [['e', 'e', 'e', 'e', 'e', 'e', 'e'], []] });
  g.players[0].pendingChoice = ['a', 'q', 'e', 'i', 'o', 'u', 'n'];
  takeCpuTurn(g, 0, buildWordList(new Dictionary(DICT)), mulberry32(1));
  assert.ok(g.players[0].rack.includes('q'));
  assert.equal(g.players[0].pendingChoice, undefined);
});
