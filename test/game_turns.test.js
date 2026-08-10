import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError, IDLE_SKIP_MS, STAR_JUMP } from '../public/engine/game.js';
import { Dictionary } from '../public/engine/dictionary.js';
import { WORLD } from '../public/engine/board.js';
import { mulberry32 } from '../public/engine/tiles.js';
import { makeGame, tilesFor } from './helpers.js';

const anything = { has: (w) => typeof w === 'string' && w.length > 1 };
const table = (names = ['Ana', 'Ben', 'Cleo'], now) => {
  const g = new Game({ dictionary: anything, rng: mulberry32(3), now });
  g.fruits.clear();
  names.forEach((n) => g.addPlayer(n));
  return g;
};
const play = (g, id, x, y, n = 2) => {
  const p = g.players[id];
  const tiles = [];
  for (let i = 0; i < n; i++) {
    if (!g.board.get(x + i, y)) tiles.push({ x: x + i, y, letter: p.rack[tiles.length] });
  }
  return g.place({ playerId: id, tiles });
};


// ------------------------------------------------------------ turn modes

test('new games take strict turns, in seat order', () => {
  const g = table();
  assert.equal(g.mode, 'turns');
  assert.equal(g.turnId, 0);
  assert.throws(() => play(g, 1, g.startCell.x, g.startCell.y), /Ana's turn/);
  play(g, 0, g.startCell.x, g.startCell.y, 3);
  assert.equal(g.turnId, 1);
  assert.throws(() => play(g, 2, g.startCell.x, g.startCell.y + 1), /Ben's turn/);
  play(g, 1, g.startCell.x, g.startCell.y + 1, 3);
  assert.equal(g.turnId, 2);
});

test('the turn wraps round the table', () => {
  const g = table();
  g.pass({ playerId: 0 });
  g.pass({ playerId: 1 });
  g.pass({ playerId: 2 });
  assert.equal(g.turnId, 0);
});

test('free-for-all lets anyone move, but never twice running', () => {
  const g = table();
  g.setMode({ playerId: 0, mode: 'free' });
  assert.equal(g.mode, 'free');
  play(g, 0, g.startCell.x, g.startCell.y, 3);
  // Cleo may jump in ahead of Ben...
  play(g, 2, g.startCell.x, g.startCell.y + 1, 3);
  // ...but not go again.
  assert.throws(() => play(g, 2, g.startCell.x, g.startCell.y + 2), /after a friend/);
});

test('only the admin sets the mode, and switching resumes where play was', () => {
  const g = table();
  assert.throws(() => g.setMode({ playerId: 1, mode: 'free' }), /only the game admin/);
  assert.throws(() => g.setMode({ playerId: 0, mode: 'sideways' }), /unknown mode/);
  g.setMode({ playerId: 0, mode: 'free' });
  play(g, 0, g.startCell.x, g.startCell.y, 3);
  play(g, 2, g.startCell.x, g.startCell.y + 1, 3); // Cleo went last
  g.setMode({ playerId: 0, mode: 'turns' });
  assert.equal(g.turnId, 0); // ...so it is Ana's again, not seat 0 by default
  assert.match(g.log.join('\n'), /strict turns/);
});

// --------------------------------------------------------- skipping idlers

test('the admin can skip whoever is holding things up', () => {
  const g = table();
  assert.throws(() => g.skipTurn({ playerId: 1, targetId: 0 }), /only the game admin/);
  const r = g.skipTurn({ playerId: 0, targetId: 0 });
  assert.equal(r.skipped, 'Ana');
  assert.equal(g.turnId, 1);
  assert.match(g.log.join('\n'), /Ana's turn was skipped/);
  // Only the seat actually holding the turn can be skipped.
  assert.throws(() => g.skipTurn({ playerId: 0, targetId: 2 }), /not Cleo's turn/);
});

test('there is nothing to skip in a free-for-all', () => {
  const g = table();
  g.setMode({ playerId: 0, mode: 'free' });
  assert.throws(() => g.skipTurn({ playerId: 0, targetId: 0 }), /free-for-all/);
});

test('a player who sits on their turn for eight hours is passed by', () => {
  let nowMs = Date.UTC(2026, 0, 1, 9);
  const g = table(['Ana', 'Ben'], () => nowMs);
  assert.equal(g.turnId, 0);

  nowMs += IDLE_SKIP_MS - 60_000;
  assert.equal(g.tickClock(), false); // still within the hour
  assert.equal(g.turnId, 0);

  nowMs += 120_000;
  assert.equal(g.tickClock(), true);
  assert.equal(g.turnId, 1);
  assert.match(g.log.join('\n'), /Ana was away/);
});

test('the idle clock restarts whenever you act', () => {
  let nowMs = Date.UTC(2026, 0, 1, 9);
  const g = table(['Ana', 'Ben'], () => nowMs);
  nowMs += IDLE_SKIP_MS - 1000;
  g.pass({ playerId: 0 }); // Ana acts just in time
  assert.equal(g.turnId, 1);
  nowMs += 2000;
  assert.equal(g.tickClock(), false); // Ben has only just been handed it
  assert.equal(g.turnId, 1);
});

test('CPU seats are never skipped for idling', () => {
  let nowMs = Date.UTC(2026, 0, 1, 9);
  const g = new Game({ dictionary: anything, rng: mulberry32(3), now: () => nowMs });
  g.fruits.clear();
  g.addPlayer('Ana');
  g.addCpu();
  g.turnId = 1; // the robot's go
  nowMs += IDLE_SKIP_MS + 60_000;
  assert.equal(g.tickClock(), false);
  assert.equal(g.turnId, 1);
});

// ------------------------------------------------- one payday per word

test('a word pays a player once a day, however often they make it', () => {
  const g = makeGame(['cat', 'cot'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']],
  });
  const ana = g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.ok(ana.points > 0);

  g.players[1].rack = ['o'];
  const ben = g.mutate({ playerId: 1, x: 1, y: 0, letter: 'o' }); // COT
  assert.ok(ben.points > 0, 'CAT paid Ana, but COT is new to Ben');

  g.players[0].rack = ['a'];
  const anaAgain = g.mutate({ playerId: 0, x: 1, y: 0, letter: 'a' }); // CAT again
  assert.equal(anaAgain.points, 0);
  assert.equal(g.players[0].score, ana.points);

  g.players[1].rack = ['o'];
  const benAgain = g.mutate({ playerId: 1, x: 1, y: 0, letter: 'o' }); // COT again
  assert.equal(benAgain.points, 0);
  assert.equal(g.players[1].score, ben.points);
});

test('the ledger is per player, and clears with the new day', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.deepEqual(g.players[0].scored, ['cat']);
  assert.deepEqual(g.players[1].scored, []);
  g.startNewDay();
  assert.deepEqual(g.players[0].scored, []);
});

test('a repeat is reported, not silently zeroed', () => {
  const g = table(['Ana', 'Ben']); // any run of letters counts here
  g.setMode({ playerId: 0, mode: 'free' });
  g.players[0].rack = ['a', 't'];
  g.place({ playerId: 0, tiles: tilesFor('at', g.startCell.x, g.startCell.y) });
  g.pass({ playerId: 1 }); // ...so Ana may go again
  g.players[0].rack = ['a', 't'];
  const r = g.place({
    playerId: 0,
    tiles: tilesFor('at', g.startCell.x, g.startCell.y + 1),
  });
  // AT itself pays nothing the second time; the fresh cross-words it makes
  // are new, and still do.
  assert.deepEqual(r.repeats, ['at']);
  assert.match(g.log.join('\n'), /AT already scored today/);
});

// -------------------------------------------------- the star on an empty bag

test('an empty bag sends the star at least twenty cells away', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  const was = { ...g.startCell };
  g.bag.pool = []; // the last letters have gone
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const dx = Math.abs(g.startCell.x - was.x);
  const dy = Math.abs(g.startCell.y - was.y);
  const d = Math.max(Math.min(dx, WORLD - dx), Math.min(dy, WORLD - dy));
  assert.ok(d >= STAR_JUMP, `the star only moved ${d}`);
  assert.match(g.log.join('\n'), /the ★ moved somewhere new/);
});

test('the star jumps once, not on every move after', () => {
  const g = makeGame(['cat', 'at', 'tat'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['a', 't', 'e', 'e', 'e', 'e', 'e']],
  });
  g.bag.pool = [];
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const after = { ...g.startCell };
  g.players[1].rack = ['a', 't'];
  // Hang AT off the T, well clear of the C and A above it.
  g.place({ playerId: 1, tiles: [{ x: 2, y: 1, letter: 'a' }, { x: 2, y: 2, letter: 't' }] });
  assert.deepEqual(g.startCell, after);
  assert.equal(g.log.filter((l) => /moved somewhere new/.test(l)).length, 1);
});

// ------------------------------------------------------------- overwriting

test('you can write straight over letters, and pocket what you cover', () => {
  const g = makeGame(['cat', 'dog', 'do', 'og'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['d', 'o', 'g', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const before = g.players[1].rack.length;
  const r = g.overwrite({ playerId: 1, tiles: tilesFor('dog', 0, 0) });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'dog');
  assert.equal(r.taken, 3, 'the three covered letters should be pocketed');
  assert.equal(g.players[1].rack.length, before - 3 + 3);
  assert.match(g.log.join('\n'), /wrote over "DOG"/);
});

test('an overwrite must leave every word real, and must say something new', () => {
  const g = makeGame(['cat', 'cot'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['c', 'a', 't', 'x', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  // Writing CAT back over CAT changes nothing at all.
  assert.throws(
    () => g.overwrite({ playerId: 1, tiles: tilesFor('cat', 0, 0) }),
    /change nothing/,
  );
  // A word the dictionary doesn't know: refused, and the board is untouched.
  assert.throws(() => g.overwrite({ playerId: 1, tiles: tilesFor('cxt', 0, 0) }), /not a real word/);
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cat', 'a refused overwrite must not touch the board');

  // Restating the letters that already fit is free: COT only spends the O.
  g.players[1].rack = ['o'];
  const r = g.overwrite({ playerId: 1, tiles: tilesFor('cot', 0, 0) });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'cot');
  assert.equal(r.taken, 1, 'only the A was prised off');
});

test('overwriting nothing is just a placement, and is refused as one', () => {
  const g = makeGame(['cat', 'at'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  assert.throws(
    () => g.overwrite({ playerId: 0, tiles: tilesFor('cat', 0, 0) }),
    /writes over nothing/,
  );
});

test('an overwrite balances the rack: a tile out, a tile in', () => {
  const g = makeGame(['cat', 'dog', 'do', 'og'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['d', 'o', 'g']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const ben = g.players[1];
  ben.rack = ['d', 'o', 'g', ...Array(9).fill('e')]; // at the 12-tile cap
  const bagBefore = g.bag.pool.length;
  const r = g.overwrite({ playerId: 1, tiles: tilesFor('dog', 0, 0) });
  assert.equal(r.taken, 3);
  assert.equal(ben.rack.length, 12, 'three spent, three picked up');
  assert.equal(g.bag.pool.length, bagBefore, 'nothing needed to go back');
});

test('a rotation still never lets one player go twice running', () => {
  // Alone at the table the turn comes straight back to you, which must not
  // become a loophole in the rule that nobody plays twice in a row.
  const g = table(['Solo']);
  assert.equal(g.mode, 'turns');
  g.players[0].rack = ['a', 't', 'e', 'e', 'e', 'e', 'e'];
  play(g, 0, g.startCell.x, g.startCell.y, 2);
  assert.equal(g.turnId, 0, 'the turn is theirs again');
  assert.equal(g.isTheirTurn(0), false, '...but they have just played');
  assert.throws(() => play(g, 0, g.startCell.x, g.startCell.y + 1, 2), /add a friend or a CPU/);
});

test('a newcomer breaks the deadlock when the turn has nowhere to go', () => {
  const g = table(['Solo']);
  g.players[0].rack = ['a', 't', 'e', 'e', 'e', 'e', 'e'];
  play(g, 0, g.startCell.x, g.startCell.y, 2);
  assert.equal(g.isTheirTurn(0), false);
  // The turn was pointing at the only player, who had just gone. Seating a
  // second player must hand it over rather than leaving nobody able to act.
  const cpu = g.addCpu();
  assert.equal(g.turnId, cpu.id);
  assert.equal(g.isTheirTurn(cpu.id), true);
});
