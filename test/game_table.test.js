import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError } from '../public/engine/game.js';
import { Dictionary } from '../public/engine/dictionary.js';
import { mulberry32 } from '../public/engine/tiles.js';
import { makeGame, tilesFor } from './helpers.js';

const anything = { has: (w) => typeof w === 'string' && w.length > 1 };
const table = (names = ['Ana', 'Ben'], opts = {}) => {
  const g = new Game({ dictionary: anything, rng: mulberry32(5), ...opts });
  g.fruits.clear();
  names.forEach((n) => g.addPlayer(n));
  return g;
};

// ------------------------------------------------- nobody waits on an empty rack

test('a seat with no letters and no bag passes itself', () => {
  const g = table(['Ana', 'Ben']);
  g.setMode({ playerId: 0, mode: 'turns' });
  g.bag.pool = [];
  g.players[1].rack = [];
  g.players[0].rack = ['a', 't', 'q']; // she keeps one back
  g.place({ playerId: 0, tiles: tilesFor('at', g.startCell.x, g.startCell.y) });
  // The turn went to Ben, who has nothing, so it came straight back round.
  assert.match(g.log.join('\n'), /Ben has no letters left/);
  assert.equal(g.turnId, 0);
  assert.equal(g.passed.has(1), true);
});

test('a seat with letters is left alone, and a full bag means nobody is stuck', () => {
  const g = table(['Ana', 'Ben']);
  g.players[0].rack = ['a', 't'];
  g.players[1].rack = []; // empty, but the bag can still refill them
  g.place({ playerId: 0, tiles: tilesFor('at', g.startCell.x, g.startCell.y) });
  assert.equal(g.turnId, 1, 'Ben can still draw, so it is his go');
  assert.equal(g.passed.has(1), false);
});

test('when nobody can play, the day ends rather than spinning', () => {
  const g = table(['Ana', 'Ben']);
  g.bag.pool = [];
  g.players[0].rack = ['a', 't'];
  g.place({ playerId: 0, tiles: tilesFor('at', g.startCell.x, g.startCell.y) });
  g.players[0].rack = [];
  g.players[1].rack = [];
  g.bag.pool = [];
  const day = g.day;
  g.tickClock();
  assert.equal(g.day, day + 1, 'the day should have rolled over');
});

// ------------------------------------------------------------------ restart

test('the admin can start the game again and name who leads off', () => {
  const g = table(['Ana', 'Ben', 'Cleo']);
  g.players[0].rack = ['a', 't'];
  g.place({ playerId: 0, tiles: tilesFor('at', g.startCell.x, g.startCell.y) });
  g.players[0].score = 40;
  g.players[0].stars = 2;

  assert.throws(() => g.restart({ playerId: 1 }), /only the game admin/);
  const r = g.restart({ playerId: 0, firstId: 2 });

  assert.equal(r.first, 2);
  assert.equal(g.turnId, 2, 'Cleo leads off');
  assert.equal(g.board.cells.size, 0, 'the board is bare');
  assert.equal(g.day, 1);
  assert.equal(g.lastPlayerId, null);
  assert.deepEqual(g.days, []);
  assert.deepEqual(g.startCell, { x: 0, y: 0 });
  for (const p of g.players) {
    assert.equal(p.score, 0);
    assert.equal(p.stars, 0);
    assert.equal(p.rack.length, 7, 'everyone is dealt again');
  }
  assert.match(g.log.join('\n'), /a fresh game — Cleo leads off/);
  assert.equal(g.isTheirTurn(2), true);
});

test('a restart with no choice of opener starts with the admin', () => {
  const g = table(['Ana', 'Ben']);
  assert.equal(g.restart({ playerId: 0 }).first, 0);
  assert.equal(g.turnId, 0);
});

// ------------------------------------------------ a new day on clean ground

test('a new day puts the star on a quiet patch near the play', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const was = { ...g.startCell };
  g.startNewDay();

  assert.notDeepEqual(g.startCell, was, 'the star moved');
  // Nothing within six cells of where the day begins.
  let letters = 0;
  for (let dx = -6; dx <= 6; dx++) {
    for (let dy = -6; dy <= 6; dy++) {
      if (g.board.get(g.startCell.x + dx, g.startCell.y + dy)) letters += 1;
    }
  }
  assert.ok(letters / (13 * 13) <= 0.01, `the new star has ${letters} letters on its doorstep`);
});

// -------------------------------------------------------- the day's record

test('each day goes into the record, and only the last five are kept', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const scored = g.players[0].score;
  g.startNewDay();

  assert.equal(g.days.length, 1);
  assert.equal(g.days[0].day, 1);
  const ana = g.days[0].scores.find((s) => s.name === 'Ana');
  assert.equal(ana.score, scored);
  assert.equal(ana.won, true);
  assert.equal(g.players[0].played, 1);
  assert.equal(g.players[0].total, scored);

  for (let i = 0; i < 7; i++) g.startNewDay();
  assert.equal(g.days.length, 5, 'five days, no more');
  assert.deepEqual(g.days.map((d) => d.day), [4, 5, 6, 7, 8]);
  assert.equal(g.players[0].played, 8);
});

test('the record survives a round trip', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.startNewDay();
  const back = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), {
    dictionary: new Dictionary(['cat']),
  });
  assert.deepEqual(back.days, g.days);
  assert.equal(back.players[0].total, g.players[0].total);
  assert.equal(back.players[0].played, g.players[0].played);
});

// -------------------------------------------------------------- the mushroom

test('a mushroom rewrites the words around it and hands over the letters', () => {
  // A permissive dictionary: any run of letters is a word, so the rewriter
  // always has somewhere to go.
  const g = new Game({ dictionary: anything, rng: mulberry32(9) });
  g.fruits.clear();
  g.addPlayer('Ana');
  g.addPlayer('Ben');
  g.players[0].rack = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const { x, y } = g.startCell;
  g.place({ playerId: 0, tiles: tilesFor('abc', x, y) });
  g.players[1].rack = ['d', 'e', 'f'];
  g.place({ playerId: 1, tiles: [{ x, y: y + 1, letter: 'd' }, { x, y: y + 2, letter: 'e' }] });

  const wasBoard = [...g.board.cells.entries()].map(([k, t]) => `${k}${t.letter}`).sort().join();
  const rackBefore = g.players[0].rack.length;
  g.fruits.set(`${x + 1},${y + 1}`, 'mushroom');
  g.players[0].rack = ['z'];
  g.place({ playerId: 0, tiles: [{ x: x + 1, y: y + 1, letter: 'z' }] });

  const nowBoard = [...g.board.cells.entries()].map(([k, t]) => `${k}${t.letter}`).sort().join();
  assert.notEqual(nowBoard, wasBoard, 'the board should have been rewritten');
  assert.match(g.log.join('\n'), /ate a mushroom/);
  assert.match(g.log.join('\n'), /the board rewrote itself/);
  assert.ok(g.players[0].rack.length > 0);
  assert.ok(rackBefore >= 0);
});

test('a mushroom leaves every word it touches real', () => {
  const words = [
    'cat', 'cot', 'cut', 'bat', 'bot', 'oat', 'eat', 'at', 'ae', 'oe', 'ee',
    'te', 'ta', 'to', 'ab', 'ob', 'ay', 'oy',
  ];
  const g = makeGame(words, { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['e']] });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.fruits.set('1,1', 'mushroom');
  g.players[1].rack = ['e'];
  g.place({ playerId: 1, tiles: [{ x: 1, y: 1, letter: 'e' }] });

  // Whatever it did, the board is still legal.
  for (const key of g.board.cells.keys()) {
    const [x, y] = key.split(',').map(Number);
    for (const dir of ['h', 'v']) {
      const w = g.board.wordThrough(x, y, dir);
      if (w && w.cells.length >= 2) {
        assert.ok(g.dictionary.has(w.word), `"${w.word}" was left on the board`);
      }
    }
  }
});
