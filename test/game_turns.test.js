import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Game, GameError, IDLE_SKIP_MS, STAR_JUMP, turnBelongsTo, waitingOn,
} from '../public/engine/game.js';
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
  // The permissive dictionary here lets the same word be laid down again a
  // row lower, which is the only way to make it twice now that a word can't
  // be rewritten in place.
  const g = table(['Ana', 'Ben']);
  g.setMode({ playerId: 0, mode: 'free' });
  const { x, y } = g.startCell;
  const lay = (id, row) => {
    g.players[id].rack = ['c', 'a', 't'];
    return g.place({ playerId: id, tiles: tilesFor('cat', x, row) });
  };

  const ana = lay(0, y);
  assert.ok(ana.points > 0);
  assert.deepEqual(ana.repeats, []);

  const ben = lay(1, y + 1);
  assert.ok(ben.points > 0, 'CAT paid Ana, but it is new to Ben');
  assert.deepEqual(ben.repeats, []);

  const anaAgain = lay(0, y + 2);
  assert.deepEqual(anaAgain.repeats, ['cat'], 'she has been paid for CAT today');
  assert.equal(g.players[0].scored.includes('cat'), true);

  const benAgain = lay(1, y + 3);
  assert.deepEqual(benAgain.repeats, ['cat']);
});

test('a swap is a turn, and is paid for in letters', () => {
  const g = makeGame(['cat', 'cot'], {
    mode: 'turns',
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.equal(g.turnId, 1);

  const r = g.swap({ playerId: 1, swaps: [{ x: 1, y: 0, letter: 'o' }] });
  assert.equal(r.points, 0); // no score: what you get is the A off the board
  assert.deepEqual(r.took, ['a']);
  assert.equal(g.turnId, 0, 'the rotation moved on');
  assert.equal(g.lastPlayerId, 1);
  assert.equal(g.isTheirTurn(1), false);
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

test('the old overwrite and steal moves are gone', () => {
  const g = makeGame(['cat', 'cot'], {
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.equal(typeof g.overwrite, 'undefined');
  assert.equal(typeof g.stealReplace, 'undefined');
  assert.throws(() => g.apply({ type: 'overwrite', playerId: 1, tiles: [] }), /unknown move/);
  assert.throws(() => g.apply({ type: 'steal', playerId: 1 }), /unknown move/);
  // A placement writes over letters on its way past, but it is still a
  // placement: it has to put at least one letter on empty ground.
  assert.throws(
    () => g.place({ playerId: 1, tiles: [{ x: 1, y: 0, letter: 'o' }] }),
    /at least one letter on empty ground/,
  );
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

// ------------------------------------------- the same answer from a snapshot

test('a stored snapshot answers "whose turn" exactly as the live game does', () => {
  for (const mode of ['turns', 'free']) {
    const g = makeGame(['cat', 'cot'], {
      mode,
      racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], ['o', 'e', 'e', 'e', 'e', 'e', 'e']],
    });
    g.addPlayer('Cass');
    const check = (why) => {
      const snap = JSON.parse(JSON.stringify(g.toJSON()));
      for (const p of g.players) {
        assert.equal(
          turnBelongsTo(snap, p.id),
          g.isTheirTurn(p.id),
          `${mode}: ${p.name} ${why}`,
        );
      }
    };
    check('before anyone plays');
    g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
    check('after Ana plays');
    g.pass({ playerId: 1 });
    check('after Ben passes');
  }
});

test('waitingOn names the one seat that may move, and nobody in a free-for-all', () => {
  const turns = makeGame(['cat'], { mode: 'turns' });
  turns.addPlayer('Cass');
  assert.equal(waitingOn(turns).name, 'Ana');

  const free = makeGame(['cat'], { mode: 'free' });
  free.addPlayer('Cass');
  assert.equal(waitingOn(free), null, 'three players may all move: nobody in particular');

  // Once two of the three have been ruled out, there is a name again.
  free.lastPlayerId = 0;
  assert.equal(waitingOn(free), null);
  const duo = makeGame(['cat'], { mode: 'free' });
  duo.lastPlayerId = 0;
  assert.equal(waitingOn(duo).name, 'Ben');
});
