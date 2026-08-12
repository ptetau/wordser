import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, BRIDGE_REACH } from '../public/engine/game.js';
import { Dictionary } from '../public/engine/dictionary.js';
import { mulberry32 } from '../public/engine/tiles.js';
import { WORLD } from '../public/engine/board.js';
import { makeGame, tilesFor } from './helpers.js';

// Every day opens its own island, rooted on the ★. Yesterday's words are
// out there in the dark and out of bounds — until somebody bridges to them,
// at which point the two are one island and all of it is in play again.

const anything = { has: (w) => typeof w === 'string' && w.length > 1 };

/** A game whose dictionary takes anything, so the shape of play is the test. */
function islands(seed = 5) {
  const g = new Game({ dictionary: anything, rng: mulberry32(seed) });
  g.fruits.clear();
  g.mode = 'free';
  g.addPlayer('Ana');
  g.addPlayer('Ben');
  return g;
}

const lay = (g, id, x, y, word) => {
  g.players[id].rack = [...word];
  g.lastPlayerId = null;
  return g.place({ playerId: id, tiles: tilesFor(word, x, y) });
};

test('a new day is its own island: yesterday is out of reach', () => {
  const g = islands();
  const first = { ...g.startCell };
  lay(g, 0, first.x, first.y, 'ana');
  g.startNewDay();
  const star = g.startCell;
  assert.notDeepEqual(star, first, 'the ★ moved');
  assert.deepEqual(g.islandCell, { ...star }, 'and the island moved with it');

  // The day has to open on its own ★, wherever else there are letters.
  assert.throws(() => lay(g, 1, star.x + 3, star.y + 3, 'bo'), /must cover the start cell/);
  assert.throws(() => lay(g, 1, first.x, first.y + 1, 'bo'), /must cover the start cell/);
  lay(g, 1, star.x, star.y, 'bo');
  assert.equal(g.island().size, 2);

  // Now the island exists, yesterday's word is still out of bounds: it
  // cannot be built on...
  assert.throws(() => lay(g, 0, first.x, first.y + 1, 'no'), /build out from the island/);
  // ...nor written over.
  g.players[0].rack = ['z'];
  g.lastPlayerId = null;
  assert.throws(
    () => g.swap({ playerId: 0, swaps: [{ x: first.x, y: first.y, letter: 'z' }] }),
    /older island/,
  );
});

test('a bridge joins the islands, and then the old words are fair game', () => {
  const g = islands();
  const old = { ...g.startCell };
  lay(g, 0, old.x, old.y, 'ana');
  g.startNewDay();
  // Put today's ★ a known six cells below yesterday's word, so the bridge
  // is a straight line and the test is about the rule, not the geometry.
  g.startCell = { x: old.x, y: old.y + 6 };
  g.islandCell = { ...g.startCell };
  lay(g, 1, g.startCell.x, g.startCell.y, 'be');
  assert.equal(g.island().size, 2);

  const key = (x, y) => `${x},${y}`;
  assert.equal(g.island().has(key(old.x, old.y)), false);
  for (let y = old.y + 5; y > old.y; y--) {
    g.players[0].rack = ['q'];
    g.lastPlayerId = null;
    g.place({ playerId: 0, tiles: [{ x: old.x, y, letter: 'q' }] });
  }
  assert.equal(g.island().has(key(old.x, old.y)), true, 'the two are one island now');

  // And yesterday's letters may be written over at last.
  g.players[1].rack = ['z'];
  g.lastPlayerId = null;
  const r = g.swap({ playerId: 1, swaps: [{ x: old.x, y: old.y, letter: 'z' }] });
  assert.deepEqual(r.took, ['a']);
});

test('a new day lands within a bridge of the words already down', () => {
  // Twenty days of play, each one measured: the ★ never opens further from
  // the board than a quarter of a bag of letters can span.
  for (let seed = 1; seed <= 6; seed++) {
    const g = islands(seed);
    for (let day = 0; day < 4; day++) {
      const star = g.startCell;
      lay(g, day % 2, star.x, star.y, 'abcde');
      lay(g, (day + 1) % 2, star.x, star.y + 1, 'fghij');
      g.startNewDay();
      const cells = [...g.board.cells.keys()].map((k) => k.split(',').map(Number));
      let near = Infinity;
      for (const [x, y] of cells) {
        const ax = Math.abs(x - g.startCell.x);
        const ay = Math.abs(y - g.startCell.y);
        near = Math.min(near, Math.max(Math.min(ax, WORLD - ax), Math.min(ay, WORLD - ay)));
      }
      assert.ok(
        near <= BRIDGE_REACH,
        `seed ${seed} day ${day}: the ★ opened ${near} cells from anything`,
      );
      assert.ok(!g.board.get(g.startCell.x, g.startCell.y), 'and on clear ground');
    }
  }
});

test('the ★ wandering on an empty bag leaves the island where it is', () => {
  const g = makeGame(['cat', 'cats'], {
    racks: [['c', 'a', 't', 's', 'e', 'e', 'e'], ['s', 'e', 'e', 'e', 'e', 'e', 'e']],
  });
  g.bag.pool = [];
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  assert.match(g.log.join('\n'), /moved somewhere new/);
  assert.notDeepEqual(g.startCell, g.islandCell);
  // Play carries on where it was, not where the ★ went.
  const r = g.place({ playerId: 1, tiles: [{ x: 3, y: 0, letter: 's' }] });
  assert.deepEqual(r.words, ['cats']);
});

test('islands survive a round trip', () => {
  const g = islands();
  lay(g, 0, g.startCell.x, g.startCell.y, 'ana');
  g.startNewDay();
  const revived = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), { dictionary: anything });
  assert.deepEqual(revived.islandCell, g.islandCell);
  assert.deepEqual(revived.island(), g.island());
  // Old saves have no island of their own, and are never left unplayable:
  // whatever the ★ is doing, the revived game has an island to build on.
  const legacy = g.toJSON();
  delete legacy.islandCell;
  const old = Game.fromJSON(legacy, { dictionary: anything });
  assert.ok(old.island().size > 0, 'a revived game is always playable');
});

test('a save from before islands, with a wandered ★, keeps playing where it was', () => {
  const g = makeGame(['cat', 'cats'], {
    racks: [['c', 'a', 't', 's', 'e', 'e', 'e'], ['s', 'e', 'e', 'e', 'e', 'e', 'e']],
  });
  g.bag.pool = []; // the empty bag sends the ★ somewhere new...
  g.place({ playerId: 0, tiles: tilesFor('cat', 0, 0) });
  const save = g.toJSON();
  delete save.islandCell; // ...and this save predates islands entirely
  const revived = Game.fromJSON(save, { dictionary: new Dictionary(['cat', 'cats']) });

  // Rooting the island on that wandered ★ would strand everyone; rooting it
  // on the last move is where the game actually is.
  assert.ok(revived.island().size >= 3, 'CAT is the island');
  const r = revived.place({ playerId: 1, tiles: [{ x: 3, y: 0, letter: 's' }] });
  assert.deepEqual(r.words, ['cats']);
});
