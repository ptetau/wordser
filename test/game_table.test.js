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
  g.fruits.set(`${x + 1},${y + 1}`, 'mushroom');
  g.players[0].rack = ['z'];
  g.bag.pool = []; // so the growth below is the mushroom's doing and nothing else
  g.place({ playerId: 0, tiles: [{ x: x + 1, y: y + 1, letter: 'z' }] });

  const nowBoard = [...g.board.cells.entries()].map(([k, t]) => `${k}${t.letter}`).sort().join();
  assert.notEqual(nowBoard, wasBoard, 'the board should have been rewritten');
  assert.match(g.log.join('\n'), /ate a mushroom/);
  assert.match(g.log.join('\n'), /went into the bag for everyone/);

  // The prised-off letters are everybody's, not the eater's.
  const line = g.log.find((l) => /went into the bag/.test(l));
  const returned = Number(/and (\d+) letter/.exec(line)[1]);
  assert.ok(returned > 0);
  assert.equal(g.bag.pool.length, returned, 'they all went into the day bag');
  assert.equal(g.players[0].rack.length, 0, 'and none of them into the rack');
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

// ------------------------------------------------------- playing to a target

test('a game can be played to n words, and stops on the nth', () => {
  const g = table(['Ana', 'Ben']);
  g.setMode({ playerId: 0, mode: 'free' });
  assert.throws(() => g.setGoal({ playerId: 1, words: 3 }), /only the game admin/);
  assert.throws(() => g.setGoal({ playerId: 0, words: 0.5 }), /between 1 and/);
  g.setGoal({ playerId: 0, words: 3 });
  assert.equal(g.wordsLeft, 3);

  const { x, y } = g.startCell;
  const lay = (id, row) => {
    g.players[id].rack = ['a', 't'];
    return g.place({ playerId: id, tiles: tilesFor('at', x, row) });
  };
  const first = lay(0, y);
  assert.equal(first.wordsPlayed, 1);
  assert.equal(first.wordsLeft, 2);
  assert.equal(first.finished, null);
  lay(1, y + 1);
  assert.equal(g.wordsLeft, 1);
  assert.equal(g.over, null);

  const last = lay(0, y + 2);
  assert.ok(last.finished, 'the third word ends it');
  assert.equal(g.over.winners.length >= 1, true);
  assert.equal(g.over.best, Math.max(...g.players.map((p) => p.score)));
  assert.match(g.log.join('\n'), /word 3 of 3/);

  // And nothing more can be played.
  assert.throws(() => lay(1, y + 3), /the game is over/);
  assert.throws(() => g.pass({ playerId: 1 }), /the game is over/);
});

test('a target can be lifted, and cannot be set below what is already down', () => {
  const g = table(['Ana', 'Ben']);
  g.players[0].rack = ['a', 't'];
  g.place({ playerId: 0, tiles: tilesFor('at', g.startCell.x, g.startCell.y) });
  assert.throws(() => g.setGoal({ playerId: 0, words: 1 }), /already down/);
  g.setGoal({ playerId: 0, words: 9 });
  g.setGoal({ playerId: 0, words: null });
  assert.equal(g.goal, null);
  assert.equal(g.wordsLeft, null);
  assert.match(g.log.join('\n'), /no finish line/);
});

test('the target and the tally survive a round trip, and a restart resets the tally', () => {
  const g = table(['Ana', 'Ben']);
  g.setGoal({ playerId: 0, words: 5 });
  g.players[0].rack = ['a', 't'];
  g.place({ playerId: 0, tiles: tilesFor('at', g.startCell.x, g.startCell.y) });
  const back = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), { dictionary: anything });
  assert.equal(back.goal, 5);
  assert.equal(back.wordsPlayed, 1);
  assert.equal(back.wordsLeft, 4);

  back.restart({ playerId: 0 });
  assert.equal(back.wordsPlayed, 0, 'a fresh game counts from nothing');
  assert.equal(back.goal, 5, 'but the match is still to five');
  assert.equal(back.over, null);
});

// ----------------------------------------------------------------- forfeiting

test('forfeiting takes your seat away and gives your letters back', () => {
  const g = table(['Ana', 'Ben', 'Cleo']);
  const bagBefore = g.bag.pool.length;
  const held = g.players[1].rack.length;
  const r = g.forfeit({ playerId: 1 });

  assert.equal(r.forfeited, 'Ben');
  assert.deepEqual(g.players.map((p) => p.name), ['Ana', 'Cleo']);
  assert.equal(g.players[1].id, 1, 'the seats close up');
  assert.equal(g.bag.pool.length, bagBefore + held);
  assert.match(g.log.join('\n'), /Ben forfeited/);
  assert.equal(g.over, null, 'two are still playing');
  assert.deepEqual(r.map, [0, null, 1]);
});

test('the last player standing wins when everyone else gives up', () => {
  const g = table(['Ana', 'Ben']);
  g.players[0].rack = ['a', 't'];
  g.place({ playerId: 0, tiles: tilesFor('at', g.startCell.x, g.startCell.y) });
  g.forfeit({ playerId: 1 });
  assert.ok(g.over, 'the game should be over');
  assert.deepEqual(g.over.winners, ['Ana']);
  assert.match(g.log.join('\n'), /Ben forfeited/);
  assert.throws(() => g.forfeit({ playerId: 0 }), /already over/);
});

test('the admin can forfeit without handing the crown over first', () => {
  const g = table(['Ana', 'Ben', 'Cleo']);
  assert.equal(g.isAdmin(0), true);
  g.forfeit({ playerId: 0 });
  assert.deepEqual(g.players.map((p) => p.name), ['Ben', 'Cleo']);
  assert.equal(g.adminId, 0, 'the crown passes to the first human still playing');
  assert.equal(g.isAdmin(0), true);
  assert.match(g.log.join('\n'), /Ben runs the game now/);
});

// ------------------------------------------------------------ "don't wait for me"

test('a busy player has their turns passed for them', () => {
  const g = table(['Ana', 'Ben', 'Cleo']);
  const { x, y } = g.startCell;
  assert.equal(g.turnId, 0);

  const r = g.setAway({ playerId: 1, away: true });
  assert.equal(r.away, true);
  assert.match(g.log.join('\n'), /Ben is busy/);
  assert.equal(g.turnId, 0, 'it is still Ana\'s turn, so nothing moves yet');

  // Ana plays: the turn would be Ben's, so it goes straight past him.
  g.players[0].rack = ['a', 't'];
  g.place({ playerId: 0, tiles: tilesFor('at', x, y) });
  assert.equal(g.turnId, 2, 'Cleo, not Ben');
  assert.match(g.log.join('\n'), /Ben is away — their turn passed/);
  assert.equal(g.passed.has(1), true);
});

test('with one opponent away, the other simply plays on', () => {
  const g = table(['Ana', 'Ben']);
  g.setAway({ playerId: 1, away: true });
  const { x, y } = g.startCell;
  g.players[0].rack = ['a', 't'];
  g.place({ playerId: 0, tiles: tilesFor('at', x, y) });

  // Ben's turn came and went, so it is Ana's again — and she may take it,
  // because the skip counts as Ben having moved.
  assert.equal(g.turnId, 0);
  assert.equal(g.lastPlayerId, 1);
  assert.equal(g.isTheirTurn(0), true, 'she is not blocked by her own last word');
  g.players[0].rack = ['a', 't'];
  g.place({ playerId: 0, tiles: tilesFor('at', x, y + 1) });
  assert.equal(g.players[0].score > 0, true);
});

test('coming back is a switch you flick, and it says so', () => {
  const g = table(['Ana', 'Ben']);
  g.setAway({ playerId: 1, away: true });
  g.setAway({ playerId: 1, away: false });
  assert.equal(g.players[1].away, false);
  assert.match(g.log.join('\n'), /Ben is back at the table/);
});

test('a move of your own says you are back, even if the flag is still set', () => {
  // Free-for-all: no turns to skip, so an away player can still act.
  const g = table(['Ana', 'Ben']);
  g.setMode({ playerId: 0, mode: 'free' });
  g.setAway({ playerId: 1, away: true });
  g.players[0].rack = ['a', 't'];
  g.place({ playerId: 0, tiles: tilesFor('at', g.startCell.x, g.startCell.y) });
  g.pass({ playerId: 1 });
  assert.equal(g.players[1].away, false);
  assert.match(g.log.join('\n'), /Ben is back at the table/);
});

test('turning it off by hand puts you back too, and only you can set it', () => {
  const g = table(['Ana', 'Ben']);
  g.setAway({ playerId: 1, away: true });
  assert.equal(g.players[1].away, true);
  g.setAway({ playerId: 1, away: false });
  assert.equal(g.players[1].away, false);
  assert.equal(g.setAway({ playerId: 1, away: false }).away, false, 'a no-op is fine');
  g.addCpu();
  assert.throws(() => g.setAway({ playerId: 2, away: true }), /robot is never away/);
});

test('a table where everybody is away waits rather than spinning', () => {
  const g = table(['Ana', 'Ben']);
  g.setAway({ playerId: 0, away: true });
  g.setAway({ playerId: 1, away: true });
  const turn = g.turnId;
  const lines = g.log.length;
  g.tickClock();
  assert.equal(g.turnId, turn, 'the turn stayed put');
  assert.equal(g.log.length, lines, 'and nothing was logged in a loop');
  assert.equal(g.day, 1);
});

test('being away survives a round trip, and a restart clears it', () => {
  const g = table(['Ana', 'Ben']);
  g.setAway({ playerId: 1, away: true });
  const back = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), { dictionary: anything });
  assert.equal(back.players[1].away, true);
  back.restart({ playerId: 0 });
  assert.equal(back.players[1].away, false);
});

test('an away seat can still be skipped by hand without breaking anything', () => {
  const g = table(['Ana', 'Ben', 'Cleo']);
  g.setAway({ playerId: 0, away: true });
  // Ana holds the turn and is away: setting it resolved it straight away.
  assert.equal(g.turnId, 1);
  assert.equal(g.players[0].away, true);
});
