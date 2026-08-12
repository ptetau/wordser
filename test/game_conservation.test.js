import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../public/engine/game.js';
import { Board, DIRS } from '../public/engine/board.js';
import { BLANK, DISTRIBUTION, mulberry32 } from '../public/engine/tiles.js';
import { makeGame, tilesFor } from './helpers.js';

const SET_SIZE = Object.values(DISTRIBUTION).reduce((a, b) => a + b, 0); // 100
// A day holds two sets: the hundred the table plays with, and the hundred
// the fruit hand out from.
const DAY_SIZE = SET_SIZE * 2;

/** Every letter the game is holding, wherever it currently sits. */
function census(game) {
  const counts = new Map();
  const add = (l) => counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const l of game.bag.pool) add(l);
  for (const l of game.fruitBag.pool) add(l);
  for (const p of game.players) {
    for (const l of p.rack) add(l);
    for (const l of p.pendingChoice ?? []) add(l);
  }
  for (const tile of game.board.cells.values()) add(tile.isBlank ? BLANK : tile.letter);
  return counts;
}

const total = (game) => [...census(game).values()].reduce((a, b) => a + b, 0);

/**
 * Give a player exactly these letters, taking them out of the bag and
 * returning whatever they held — so the test's own setup can't be the
 * thing that mints or destroys a tile.
 */
function rig(game, playerId, letters) {
  const p = game.players[playerId];
  game.bag.put(...p.rack);
  p.rack = [];
  for (const l of letters) {
    const got = game.bag.take(l);
    assert.ok(got, `the bag has no "${l}" left to rig with`);
    p.rack.push(got);
  }
}

/** Top a rack up to `n` tiles with whatever the bag offers. */
function fill(game, playerId, n) {
  const p = game.players[playerId];
  while (p.rack.length < n) {
    const l = game.bag.draw();
    assert.ok(l, 'the bag ran dry while filling a rack');
    p.rack.push(l);
  }
}

/** Nothing minted and nothing destroyed, letter by letter. */
function assertConserved(game, before, what) {
  const after = census(game);
  for (const l of new Set([...before.keys(), ...after.keys()])) {
    assert.equal(after.get(l) ?? 0, before.get(l) ?? 0, `${what}: count of "${l}" changed`);
  }
}

test('a fresh day holds two standard sets: one to play with, one for the fruit', () => {
  const g = makeGame(['cat']);
  assert.equal(total(g), DAY_SIZE);
  const c = census(g);
  for (const [letter, count] of Object.entries(DISTRIBUTION)) {
    assert.equal(c.get(letter) ?? 0, count * 2, `wrong number of "${letter}"`);
  }
  // And the two are separate: the fruit's hundred is untouched at dawn.
  assert.equal(g.fruitBag.pool.length, SET_SIZE);
});

test('placing moves letters from rack to board without creating any', () => {
  const g = makeGame(['cat']);
  rig(g, 0, ['c', 'a', 't', 'e', 'e', 'e', 'e']);
  const before = census(g);
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assertConserved(g, before, 'place');
  assert.equal(total(g), DAY_SIZE);
});

test('a chilli draws its hot letter out of the bag', () => {
  const g = makeGame(['cat']);
  rig(g, 0, ['c', 'a', 't']);
  g.fruits.set(Board.key(2, 0), 'chilli');
  const before = census(g);
  const hadJ = g.bag.pool.filter((l) => l === 'j').length;
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assertConserved(g, before, 'chilli');

  const got = g.players[0].rack.filter((l) => 'jqxz'.includes(l));
  assert.equal(got.length >= 1, true, 'expected a fiery letter');
  // Whatever it handed over came out of the bag, not out of thin air.
  if (got.includes('j')) assert.equal(g.bag.pool.filter((l) => l === 'j').length, hadJ - 1);
});

test('a chilli with no hot letters left takes the best the bag has', () => {
  const g = makeGame(['cat']);
  rig(g, 0, ['c', 'a', 't']);
  g.bag.pool = ['a', 'k', 'e']; // k is worth 5, the pick of a poor bag
  g.fruits.set(Board.key(2, 0), 'chilli');
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.equal(g.players[0].rack.includes('k'), true);
  assert.equal(g.bag.pool.includes('k'), false);
});

test('a chilli on an empty fruit bag fizzles instead of minting a letter', () => {
  const g = makeGame(['cat']);
  rig(g, 0, ['c', 'a', 't']);
  g.bag.pool = [];
  g.fruitBag.pool = []; // the fruit have nothing left to give either
  g.fruits.set(Board.key(2, 0), 'chilli');
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.deepEqual(g.players[0].rack, []);
  assert.match(g.log.join('\n'), /nothing hot left/);
});

test('a kiwi takes a real wildcard from the bag, and fizzles once both are out', () => {
  const g = makeGame(['cat']);
  rig(g, 0, ['c', 'a', 't']);
  g.fruits.set(Board.key(2, 0), 'kiwi');
  assert.equal(g.fruitBag.pool.filter((l) => l === BLANK).length, 2);
  const before = census(g);
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assertConserved(g, before, 'kiwi');
  // Conservation above already proves it wasn't conjured; the rack refill
  // may well have drawn the other one, so only count the pair as a whole.
  assert.equal(g.players[0].rack.includes(BLANK), true);
  assert.equal(census(g).get(BLANK), 4, 'two per set, two sets');

  // With no wildcards left in the bag, the kiwi has nothing to give.
  const g2 = makeGame(['cat']);
  rig(g2, 0, ['c', 'a', 't']);
  g2.fruitBag.pool = g2.fruitBag.pool.filter((l) => l !== BLANK);
  g2.fruits.set(Board.key(2, 0), 'kiwi');
  const before2 = census(g2);
  g2.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assertConserved(g2, before2, 'kiwi with no blanks');
  assert.equal(g2.players[0].rack.includes(BLANK), false);
  assert.match(g2.log.join('\n'), /both wildcards are already in play/);
});

test("a cherry's unkept letters go straight back into the fruit bag", () => {
  const g = makeGame(['cat']);
  rig(g, 0, ['c', 'a', 't']);
  g.fruits.set(Board.key(2, 0), 'cherry');
  const before = census(g);
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.equal(g.players[0].pendingChoice.length, 7);
  assertConserved(g, before, 'cherry offered'); // reserved, not conjured

  const spareBefore = g.fruitBag.pool.length;
  g.choosePendingLetter({ playerId: 0, index: 3 });
  assert.equal(g.fruitBag.pool.length, spareBefore + 6, 'six offers went home');
  assertConserved(g, before, 'cherry resolved');
  assert.equal(total(g), DAY_SIZE);
});

test('a cherry offered to a full rack returns every letter', () => {
  const g = makeGame(['cat']);
  rig(g, 0, ['c', 'a', 't']);
  g.fruits.set(Board.key(2, 0), 'cherry');
  const before = census(g);
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.bag.put(...g.players[0].rack);
  g.players[0].rack = [];
  fill(g, 0, 12); // rack at the 12-tile cap
  const midway = census(g);
  const spareBefore = g.fruitBag.pool.length;
  const r = g.choosePendingLetter({ playerId: 0, index: 0 });
  assert.equal(r.letter, null);
  assert.equal(g.players[0].pendingChoice, undefined);
  assert.match(g.log.join('\n'), /went back in the bag/);
  assert.equal(g.fruitBag.pool.length, spareBefore + 7); // all seven returned
  assertConserved(g, midway, 'cherry declined');
  assert.equal(total(g), DAY_SIZE);
});

test('an unresolved cherry returns to the fruit bag when its player is removed', () => {
  const g = makeGame(['cat']);
  rig(g, 0, ['c', 'a', 't']);
  g.fruits.set(Board.key(2, 0), 'cherry');
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.transferAdmin({ playerId: 0, toId: 1 });
  const before = census(g);
  g.removePlayer({ playerId: 1, targetId: 0 });
  assertConserved(g, before, 'removal with a pending cherry');
  assert.equal(total(g), DAY_SIZE);
});

test('a banana swaps the whole rack through the bag', () => {
  const g = makeGame(['cat']);
  rig(g, 0, ['c', 'a', 't', 'q', 'z', 'x', 'j']);
  g.fruits.set(Board.key(2, 0), 'banana');
  const before = census(g);
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assertConserved(g, before, 'banana');
});

test("a lemon draws its two letters from the fruit's bag, not the table's", () => {
  const g = makeGame(['cat']);
  rig(g, 0, ['c', 'a', 't']);
  g.fruits.set(Board.key(2, 0), 'lemon');
  const before = census(g);
  const bagBefore = g.bag.pool.length;
  const spareBefore = g.fruitBag.pool.length;
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assertConserved(g, before, 'lemon');
  // Seven to refill the rack, then the lemon's two on top of that.
  assert.equal(g.players[0].rack.length, 9);
  assert.equal(g.bag.pool.length, bagBefore - 7, 'the refill, and only the refill');
  assert.equal(g.fruitBag.pool.length, spareBefore - 2, 'the lemon paid for itself');
});

test('a swap trades tile for tile, even with a full rack', () => {
  const g = makeGame(['cat', 'cot', 'bat']);
  rig(g, 1, ['c', 'a', 't', 'e', 'e', 'e', 'e']);
  rig(g, 0, ['o', 'b']);
  fill(g, 0, 12); // no spare room anywhere
  g.place({ playerId: 1, tiles: tilesFor('cat', 0, 0) });
  const before = census(g);
  g.swap({ playerId: 0, swaps: [{ x: 1, y: 0, letter: 'o' }] });
  assert.equal(g.players[0].rack.length, 12); // spent the O, took the A
  assert.equal(g.players[0].rack.includes('a'), true);
  assertConserved(g, before, 'swap');
});

test('a multi-swap conserves just as well', () => {
  const g = makeGame(['cat', 'bat', 'bit']);
  rig(g, 1, ['c', 'a', 't', 'e', 'e', 'e', 'e']);
  rig(g, 0, ['b', 'i']);
  g.place({ playerId: 1, tiles: tilesFor('cat', 0, 0) });
  const before = census(g);
  g.swap({
    playerId: 0,
    swaps: [{ x: 0, y: 0, letter: 'b' }, { x: 1, y: 0, letter: 'i' }],
  });
  assert.equal(g.board.wordThrough(0, 0, 'h').word, 'bit');
  assertConserved(g, before, 'multi-swap');
});

test('exchanging is a straight swap through the bag', () => {
  const g = makeGame(['cat']);
  rig(g, 0, ['c', 'a', 't', 'e', 'e', 'e', 'e']);
  const before = census(g);
  g.exchange({ playerId: 0, letters: ['e', 'e'] });
  assertConserved(g, before, 'exchange');
  assert.equal(g.players[0].rack.length, 7);
});

test('a new day starts a brand-new set; only board letters carry over', () => {
  const g = makeGame(['cat']);
  rig(g, 0, ['c', 'a', 't', 'e', 'e', 'e', 'e']);
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const onBoard = g.board.cells.size;
  g.startNewDay();
  assert.equal(total(g), DAY_SIZE + onBoard);
  assert.equal(g.bag.pool.length + g.players.reduce((n, p) => n + p.rack.length, 0), SET_SIZE);
  assert.equal(g.fruitBag.pool.length, SET_SIZE, 'the fruit get a fresh hundred too');
});

// --------------------------------------------------------------- fuzzing
//
// The real guarantee is that no sequence of moves can mint or destroy a
// letter, so the rest of this file plays thousands of random ones and
// counts the tiles after every single move. The dictionary accepts any run
// of letters here: this is a test of the tile bookkeeping, not of the word
// list, and a permissive dictionary is what makes steals and mutations
// land often enough to be worth fuzzing.

const anything = { has: (w) => typeof w === 'string' && w.length > 0 };
// Every fruit but the mushroom only ever moves letters that are already in
// the day's hundred. The mushroom brings its own bag, which is the point of
// it, so it is fuzzed separately below rather than breaking the census here.
const FRUIT_TYPES = ['lemon', 'chilli', 'cherry', 'grape', 'banana', 'kiwi'];

/** Play `turns` random moves, checking the census after each one. */
function fuzz(seed, turns) {
  const g = new Game({ dictionary: anything, rng: mulberry32(seed) });
  g.fruits.clear(); // the fuzzer plants its own, right where letters land
  ['Ana', 'Ben', 'Cleo'].forEach((n) => g.addPlayer(n));
  const rng = mulberry32(seed * 7 + 1);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const occupied = () => [...g.board.cells.keys()].map((k) => k.split(',').map(Number));
  const effective = (t) => (t.isBlank ? t.as : t.letter);
  const tally = { place: 0, swap: 0, stack: 0, exchange: 0, choose: 0, fruit: 0, newDay: 0 };

  for (let turn = 0; turn < turns; turn++) {
    const p = pick(g.players);
    const before = census(g);
    const dayBefore = g.day;
    const fruitsBefore = g.log.filter((l) => /ate a/.test(l)).length;
    try {
      if (p.pendingChoice) {
        g.choosePendingLetter({ playerId: p.id, index: Math.floor(rng() * p.pendingChoice.length) });
        tally.choose++;
      } else if (!g.island().size) {
        // Nothing on today's ★ yet — that is where the day has to open.
        const tiles = [];
        for (let i = 0; tiles.length < 3 && i < 5; i++) {
          const x = g.startCell.x + i;
          if (g.board.get(x, g.startCell.y)) continue;
          const letter = p.rack[tiles.length];
          if (letter === undefined) break;
          tiles.push({
            x, y: g.startCell.y,
            letter: letter === BLANK ? 'a' : letter,
            fromBlank: letter === BLANK,
          });
        }
        if (!tiles.length) continue;
        g.place({ playerId: p.id, tiles });
        tally.place++;
      } else {
        const roll = rng();
        if (roll < 0.5 && p.rack.length) {
          // Hang letters off a tile already on the board.
          const [ox, oy] = pick(occupied());
          const dir = rng() < 0.5 ? 'h' : 'v';
          const [dx, dy] = DIRS[dir];
          const side = rng() < 0.5 ? 1 : -1;
          const n = 1 + Math.floor(rng() * Math.min(3, p.rack.length));
          const tiles = [];
          // Every so often the word writes straight over what is there,
          // which is a placement too — and puts letters back in the bag.
          const overwrite = rng() < 0.3;
          for (let i = 1; i <= n; i++) {
            const x = ox + side * i * dx;
            const y = oy + side * i * dy;
            if (g.board.get(x, y) && !overwrite) break;
            const letter = p.rack[tiles.length];
            if (letter === undefined) break;
            tiles.push({ x, y, letter: letter === BLANK ? 'a' : letter, fromBlank: letter === BLANK });
          }
          if (!tiles.length) continue;
          if (rng() < 0.35) g.fruits.set(Board.key(tiles[0].x, tiles[0].y), pick(FRUIT_TYPES));
          g.place({ playerId: p.id, tiles });
          tally.place++;
        } else if (roll < 0.85) {
          // Write over one to three board letters at once — as a swap, which
          // takes the letters, or a stack, which posts them back into the
          // bag. Both have to be one reach, so the cells are taken along a
          // line from the first: neighbours share the word running through
          // them.
          const usable = p.rack.filter((l) => l !== BLANK);
          if (!usable.length) continue;
          const [ox, oy] = pick(occupied());
          const [dx, dy] = DIRS[rng() < 0.5 ? 'h' : 'v'];
          const n = 1 + Math.floor(rng() * Math.min(3, usable.length));
          const plays = [];
          for (let i = 0; i < n; i++) {
            if (!g.board.get(ox + i * dx, oy + i * dy)) break;
            plays.push({ x: ox + i * dx, y: oy + i * dy, letter: usable[i] });
          }
          if (!plays.length) continue;
          if (rng() < 0.5) {
            g.swap({ playerId: p.id, swaps: plays });
            tally.swap += 1;
          } else {
            g.stack({ playerId: p.id, stacks: plays });
            tally.stack += 1;
          }
        } else if (roll < 0.93) {
          const n = 1 + Math.floor(rng() * Math.min(7, p.rack.length));
          g.exchange({ playerId: p.id, letters: p.rack.slice(0, n) });
          tally.exchange++;
        } else {
          g.pass({ playerId: p.id });
        }
      }
    } catch {
      // An illegal move for this board: the engine refused it, and a refusal
      // must leave the tiles exactly as they were — checked below like the
      // successful moves.
    }
    tally.fruit += g.log.filter((l) => /ate a/.test(l)).length - fruitsBefore;
    if (g.day !== dayBefore) {
      // A day ended: brand-new set, so re-baseline instead of comparing.
      const loose = g.bag.pool.length + g.players.reduce((n, q) => n + q.rack.length, 0);
      const spare = g.fruitBag.pool.length;
      assert.equal(loose, SET_SIZE, `seed ${seed} turn ${turn}: new day is not a full set`);
      assert.equal(spare, SET_SIZE, `seed ${seed} turn ${turn}: the fruit bag is not fresh`);
      tally.newDay++;
      continue;
    }
    assertConserved(g, before, `seed ${seed} turn ${turn}`);
  }
  return { game: g, tally };
}

test('thousands of random moves never mint or destroy a letter', () => {
  let seen = { place: 0, swap: 0, stack: 0, exchange: 0, choose: 0, fruit: 0, newDay: 0 };
  for (let seed = 1; seed <= 8; seed++) {
    const { game, tally } = fuzz(seed, 600);
    if (!tally.newDay) assert.equal(total(game), DAY_SIZE, `seed ${seed} ended off two full sets`);
    seen = Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v + tally[k]]));
  }
  // The run is only meaningful if it actually exercised every path that
  // moves letters around, so hold it to that.
  assert.ok(seen.place > 200, `too few placements: ${seen.place}`);
  assert.ok(seen.swap > 100, `too few swaps: ${seen.swap}`);
  assert.ok(seen.stack > 100, `too few stacks: ${seen.stack}`);
  assert.ok(seen.exchange > 50, `too few exchanges: ${seen.exchange}`);
  assert.ok(seen.choose > 5, `too few cherry choices: ${seen.choose}`);
  assert.ok(seen.fruit > 100, `too few fruits eaten: ${seen.fruit}`);
});

test('a mushroom moves letters from the fruit bag into the table\'s', () => {
  const g = makeGame(['cat', 'cot', 'cut', 'bat', 'bot', 'oat', 'at', 'ae', 'oe']);
  rig(g, 0, ['c', 'a', 't', 'e', 'e', 'e', 'e']);
  rig(g, 1, ['e']);
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const boardBefore = g.board.cells.size;
  const before = census(g);
  const spareBefore = g.fruitBag.pool.length;
  const bagBefore = g.bag.pool.length;

  g.fruits.set('1,1', 'mushroom');
  g.place({ playerId: 1, tiles: [{ x: 1, y: 1, letter: 'e' }] });

  const line = g.log.find((l) => /went into the bag/.test(l));
  if (!line) return; // nothing round there would budge; nothing to check
  const returned = Number(/and (\d+) letter/.exec(line)[1]);
  assert.ok(returned > 0);

  // A rewrite swaps letters in place, so the board keeps its size; the
  // letters it puts down come out of the fruit's hundred and the ones it
  // prises off land in the table's. Nothing is minted either way.
  assert.equal(g.board.cells.size, boardBefore + 1, 'one cell for the tile just played');
  assert.equal(g.fruitBag.pool.length, spareBefore - returned, 'the fruit bag paid');
  assert.ok(g.bag.pool.length >= bagBefore + returned - 7, 'the table was paid');
  assertConserved(g, before, 'mushroom');
});
