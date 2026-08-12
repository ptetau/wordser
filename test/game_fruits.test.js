import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError, RACK_TARGET } from '../public/engine/game.js';
import { Dictionary } from '../public/engine/dictionary.js';
import { mulberry32 } from '../public/engine/tiles.js';
import { Board, WORLD } from '../public/engine/board.js';
import { makeGame, tilesFor } from './helpers.js';

test('a lemon feeds you two extra letters', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.fruits.set('1,0', 'lemon');
  const r = g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.deepEqual(r.fruits, ['lemon']);
  assert.equal(g.fruits.has('1,0'), false);
  assert.equal(g.players[0].rack.length, RACK_TARGET + 2);
});

test('a chilli hands you a high-scoring letter', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.fruits.set('2,0', 'chilli');
  const r = g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.deepEqual(r.fruits, ['chilli']);
  assert.ok(g.players[0].rack.some((l) => 'jqxz'.includes(l)));
});

test('a cherry offers seven letters; choosing keeps one without using a turn', () => {
  const g = makeGame(['cat', 'ta'], {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['t', 'a', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  g.fruits.set('0,0', 'cherry');
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const offered = g.players[0].pendingChoice;
  assert.equal(offered.length, 7);

  const { letter } = g.apply({ type: 'choose', playerId: 0, index: 3 });
  assert.equal(letter, offered[3]);
  assert.ok(g.players[0].rack.includes(letter));
  assert.equal(g.players[0].pendingChoice, undefined);
  assert.throws(() => g.choosePendingLetter({ playerId: 0, index: 0 }), GameError);

  // Choosing was not a play: the friend rule still blocks Ana's next move.
  assert.throws(
    () => g.place({ playerId: 0, tiles: [{ x: 2, y: 1, letter: 'a' }] }),
    /friend/,
  );
});

test('a grape is worth bonus points', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.fruits.set('1,0', 'grape');
  const r = g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.equal(g.players[0].score, r.points + 10);
});

test('a banana deals you a completely fresh rack', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.fruits.set('1,0', 'banana');
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.equal(g.players[0].rack.length, 7);
  assert.match(g.log.join('\n'), /banana/);
});

test('a kiwi hands you a wildcard', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.fruits.set('2,0', 'kiwi');
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.ok(g.players[0].rack.includes('*'));
});

test('extending a word onto a fruit eats it', () => {
  const g = makeGame(['cat', 'cats'], {
    racks: [
      ['c', 'a', 't', 'e', 'e', 'e', 'e'],
      ['s', 'e', 'e', 'e', 'e', 'e', 'e'],
    ],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.fruits.set('3,0', 'lemon');
  const r = g.place({ playerId: 1, tiles: [{ x: 3, y: 0, letter: 's' }] });
  assert.deepEqual(r.fruits, ['lemon']);
  assert.equal(g.fruits.has('3,0'), false);
});

test('fruits spawn on empty cells near the board, capped and spread out', () => {
  const g = makeGame(['cat'], {
    players: ['Solo'],
    racks: [['c', 'a', 't', 'e', 'e', 'e', 'e']],
  });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  for (let i = 0; i < 40; i++) g.spawnFruit(1);
  assert.ok(g.fruits.size >= 1);
  assert.ok(g.fruits.size <= 12);
  const toroidal = (a, b) => Math.min(Math.abs(a - b), WORLD - Math.abs(a - b));
  for (const k of g.fruits.keys()) {
    const [x, y] = k.split(',').map(Number);
    assert.equal(g.board.get(x, y), null);
    const near = [0, 1, 2].some((ax) => toroidal(x, ax) <= 4 && toroidal(y, 0) <= 4);
    assert.ok(near, `fruit at ${k} is near the word`);
  }
});

test('fruits and pending choices survive serialization', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.fruits.set('0,1', 'cherry');
  g.players[0].pendingChoice = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const g2 = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), {
    dictionary: new Dictionary(['cat']),
  });
  assert.equal(g2.fruits.get('0,1'), 'cherry');
  assert.deepEqual(g2.players[0].pendingChoice, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const { letter } = g2.choosePendingLetter({ playerId: 0, index: 0 });
  assert.equal(letter, 'a');
});

/** Toroidal chebyshev distance, the metric the seeder works in. */
const dist = (a, b) => {
  const dx = Math.abs(a[0] - b[0]);
  const dy = Math.abs(a[1] - b[1]);
  return Math.max(Math.min(dx, WORLD - dx), Math.min(dy, WORLD - dy));
};
const spotsOf = (g) => [...g.fruits.keys()].map((k) => k.split(',').map(Number));

test('a fresh world seeds its fruit within reach of the star, without bunching', () => {
  for (const seed of [1, 9, 42, 1234]) {
    const g = new Game({ dictionary: new Dictionary(['cat']), rng: mulberry32(seed) });
    assert.equal(g.fruits.size, 10, `seed ${seed} laid out the wrong number`);
    assert.equal(g.fruits.has('0,0'), false, 'the ★ itself must stay clear');
    const spots = spotsOf(g);
    for (const s of spots) {
      const d = dist(s, [g.startCell.x, g.startCell.y]);
      assert.ok(d >= 3, `fruit at ${s} is too easy at distance ${d}`);
      assert.ok(d <= 9, `fruit at ${s} is out of reach at distance ${d}`);
    }
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        assert.ok(dist(spots[i], spots[j]) >= 4, `fruits bunch: ${spots[i]} / ${spots[j]}`);
      }
    }
  }
});

test('every fruit is reachable: none sits behind an occupied cell or off on its own', () => {
  const g = new Game({ dictionary: new Dictionary(['cat']), rng: mulberry32(5) });
  for (const k of g.fruits.keys()) {
    const [x, y] = k.split(',').map(Number);
    assert.ok(!g.board.get(x, y), 'fruit must sit on an empty cell');
  }
});

test('each new day lays out a fresh crop around the day\'s action', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.fruits.clear();
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const stale = spotsOf(g);

  g.startNewDay();
  assert.equal(g.fruits.size, 10, 'the new day needs its own crop');
  assert.deepEqual(
    spotsOf(g).filter((s) => stale.some((t) => t[0] === s[0] && t[1] === s[1])),
    [],
    'yesterday\'s leftovers should be cleared away',
  );

  // Everything is within reach of somewhere play can actually happen: the
  // new ★, or a word already on the board.
  const focals = [[g.startCell.x, g.startCell.y], ...[...g.board.cells.keys()].map((k) => k.split(',').map(Number))];
  for (const s of spotsOf(g)) {
    const nearest = Math.min(...focals.map((f) => dist(s, f)));
    assert.ok(nearest >= 3 && nearest <= 9, `fruit at ${s} sits ${nearest} from anything worth playing`);
  }
  assert.match(g.log.join('\n'), /fresh fruits are within reach/);
});

test('the fruit bag is its own hundred, and the table never pays for a fruit', () => {
  const g = makeGame(['cat', 'cats'], { racks: [['c', 'a', 't', 's', 'e', 'e', 'e'], []] });
  assert.equal(g.fruitBag.pool.length, 100, 'the fruit start with a full set');

  // A run of generous fruit, eaten one after another.
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  let handedOut = 0;
  for (const type of ['lemon', 'chilli', 'kiwi', 'lemon', 'chilli']) {
    const before = g.bag.pool.length;
    const spare = g.fruitBag.pool.length;
    g.players[0].rack = ['s'];
    g.fruits.set(Board.key(3, 0), type);
    g.lastPlayerId = null; // a one-player fixture: let her go again
    g.place({ playerId: 0, tiles: [{ x: 3, y: 0, letter: 's' }] });
    // The table's bag only ever paid for the rack refill.
    const drawn = before - g.bag.pool.length;
    assert.ok(drawn <= 7, `${type} took ${drawn} from the table's bag`);
    handedOut += spare - g.fruitBag.pool.length;
    g.board.remove(3, 0); // put the board back for the next go
  }
  assert.ok(handedOut > 0, 'the fruit bag did the giving');
  assert.equal(g.fruitBag.pool.length, 100 - handedOut);
});

test('an empty fruit bag fizzles without touching the day', () => {
  const g = makeGame(['cat', 'cats'], { racks: [['c', 'a', 't', 's', 'e', 'e', 'e'], []] });
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  g.fruitBag.pool = [];
  g.players[0].rack = ['s'];
  g.fruits.set(Board.key(3, 0), 'lemon');
  const before = g.bag.pool.length;
  g.lastPlayerId = null;
  const r = g.place({ playerId: 0, tiles: [{ x: 3, y: 0, letter: 's' }] });
  assert.deepEqual(r.fruits, ['lemon']);
  assert.match(g.log.join('\n'), /0 extra letters/);
  assert.ok(before - g.bag.pool.length <= 7, 'only the refill came out of the day');
});

test('a new day refills both bags', () => {
  const g = makeGame(['cat'], { racks: [['c', 'a', 't', 'e', 'e', 'e', 'e'], []] });
  g.fruitBag.pool = ['a', 'b'];
  g.bag.pool = ['c'];
  g.startNewDay();
  assert.equal(g.fruitBag.pool.length, 100);
  const dealt = g.players.reduce((n, p) => n + p.rack.length, 0);
  assert.equal(g.bag.pool.length + dealt, 100);
});

test('two cherries in one word offer one pile, not two', () => {
  const g = makeGame(['cats'], { racks: [['c', 'a', 't', 's', 'e', 'e', 'e'], []] });
  g.fruits.set(Board.key(1, 0), 'cherry');
  g.fruits.set(Board.key(3, 0), 'cherry');
  const spare = g.fruitBag.pool.length;
  g.place({ playerId: 0, tiles: tilesFor('cats', 0, 0) });
  assert.equal(g.players[0].pendingChoice.length, 14, 'both helpings, none lost');
  assert.equal(g.fruitBag.pool.length, spare - 14);
});
