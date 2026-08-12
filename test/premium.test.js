import { test } from 'node:test';
import assert from 'node:assert/strict';
import { premiumAt, patternAt, PERIOD, WORLD_TILES } from '../public/engine/premium.js';
import { WORLD } from '../public/engine/board.js';

/** Every board in the world, by the star at its centre. */
function* boards() {
  for (let tx = 0; tx < WORLD_TILES; tx++) {
    for (let ty = 0; ty < WORLD_TILES; ty++) yield [tx * PERIOD, ty * PERIOD];
  }
}

test('the world is tiled with boards, and the tiling divides it exactly', () => {
  assert.equal(WORLD / PERIOD, WORLD_TILES);
});

test('a board repeats itself, but its neighbour need not', () => {
  // Whatever a cell is, the same cell on the same board is the same thing
  // a world away — but one board along is a different board, and these
  // days that can mean a different layout entirely.
  for (const [sx, sy] of boards()) {
    for (const [dx, dy] of [[1, 1], [-3, 4], [5, -6]]) {
      assert.equal(premiumAt(sx + dx + WORLD, sy + dy), premiumAt(sx + dx, sy + dy));
    }
  }
  let differs = 0;
  for (const [sx, sy] of boards()) {
    for (let d = -6; d <= 6; d++) {
      if (premiumAt(sx + d, sy + 3) !== premiumAt(sx + d + PERIOD, sy + 3)) differs++;
    }
  }
  assert.ok(differs > 200, `the world is all one board again (${differs} cells differ)`);
});

test('the origin is a double-word start star and the motifs are classic', () => {
  assert.equal(premiumAt(0, 0), 'DW'); // board-centre star under the start cell
  assert.equal(premiumAt(7, 7), 'TW'); // board corner, 7 squares out
  assert.equal(premiumAt(-7, 7), 'TW');
  assert.equal(premiumAt(6, 6), 'DW'); // double-word diagonal X
  assert.equal(premiumAt(9, 9), 'DW'); // its mirror in the next board along
  assert.equal(premiumAt(2, 2), 'TL'); // triple-letter diamond
  assert.equal(premiumAt(1, 1), 'DL');
  assert.equal(premiumAt(0, 4), 'DL');
});

test('the gaps between motifs are empty', () => {
  assert.equal(premiumAt(1, 0), null);
  assert.equal(premiumAt(5, 0), null);
  assert.equal(premiumAt(6, 0), null);
  assert.equal(premiumAt(2, 1), null);
  let premium = 0;
  for (let x = 0; x < PERIOD; x++) {
    for (let y = 0; y < PERIOD; y++) if (premiumAt(x, y)) premium++;
  }
  // A real scrabble board carries 61 premiums in 225 squares.
  const density = premium / (PERIOD * PERIOD);
  assert.ok(density > 0.2 && density < 0.32, `density ${density}`);
});

test('negative coordinates behave like positive ones', () => {
  assert.equal(premiumAt(-14, 0), 'DW'); // one whole board back
  assert.equal(premiumAt(-6, -6), 'DW');
  assert.equal(premiumAt(-2, -2), 'TL');
});

test('the tiling closes seamlessly around the world', () => {
  // The pattern only meets itself at the seam if the tile divides the
  // world — the whole reason the board carries a gutter.
  assert.equal(WORLD % PERIOD, 0, `${PERIOD}-cell tile must divide the ${WORLD}-cell world`);
  for (let x = -3; x <= 3; x++) {
    for (let y = -3; y <= 3; y++) {
      assert.equal(premiumAt(x + WORLD, y), premiumAt(x, y), `seam breaks at x=${x}`);
      assert.equal(premiumAt(x, y + WORLD), premiumAt(x, y), `seam breaks at y=${y}`);
    }
  }
});

test('boards share one rim rather than doubling it at the seam', () => {
  // Where two boards meet there is a single triple-word line, not two
  // abutting ones: the classic board's last row repeats its first, so the
  // tile drops it.
  assert.equal(premiumAt(7, 0), 'TW'); // the shared rim
  assert.equal(premiumAt(8, 0), null); // ...and plain felt beside it
  assert.equal(premiumAt(6, 0), null);
  assert.equal(premiumAt(0, 7), 'TW');
  assert.equal(premiumAt(0, 8), null);
  assert.equal(premiumAt(14, 14), 'DW'); // the next board's centre star
  assert.equal(premiumAt(14, 0), 'DW'); // ...and its centre row
  // No two triple-words ever sit side by side, anywhere in the tile.
  for (let x = 0; x < 28; x++) {
    for (let y = 0; y < 28; y++) {
      if (premiumAt(x, y) !== 'TW') continue;
      assert.notEqual(premiumAt(x + 1, y), 'TW', `doubled TW across at ${x},${y}`);
      assert.notEqual(premiumAt(x, y + 1), 'TW', `doubled TW down at ${x},${y}`);
    }
  }
});

test('every lattice star the day can move to is a real board centre', () => {
  for (let x = 0; x < WORLD; x += PERIOD) {
    for (let y = 0; y < WORLD; y += PERIOD) {
      assert.equal(premiumAt(x, y), 'DW', `lattice point ${x},${y} is not a star`);
    }
  }
});

// -------------------------------------------------- a world worth crossing

test('all four kinds of board are out there, in useful numbers', () => {
  const seen = {};
  for (const [sx, sy] of boards()) {
    const kind = patternAt(sx, sy);
    seen[kind] = (seen[kind] ?? 0) + 1;
  }
  assert.deepEqual(
    Object.keys(seen).sort(),
    ['bag', 'classic', 'spiral', 'wave'],
  );
  const total = WORLD_TILES * WORLD_TILES;
  for (const [kind, n] of Object.entries(seen)) {
    assert.ok(n / total > 0.08, `only ${n} ${kind} boards in ${total}`);
  }
  assert.ok(seen.classic / total > 0.4, 'classic should still be the common case');
  assert.equal(patternAt(0, 0), 'classic', 'home is the board people know');
});

test('the scenery changes in regions, not cell by cell', () => {
  // The whole point of a smooth field: your neighbour is usually the same
  // kind of board you are, so the map has places rather than static.
  let same = 0;
  let pairs = 0;
  for (const [sx, sy] of boards()) {
    for (const [dx, dy] of [[PERIOD, 0], [0, PERIOD]]) {
      pairs++;
      if (patternAt(sx, sy) === patternAt(sx + dx, sy + dy)) same++;
    }
  }
  const agreement = same / pairs;
  assert.ok(agreement > 0.6, `boards agree with their neighbours only ${agreement.toFixed(2)}`);
  assert.ok(agreement < 0.98, `the world is one big region (${agreement.toFixed(2)})`);
});

test('every board is framed the same way, whatever is inside it', () => {
  // The rim belongs to both boards it separates, so it is drawn the classic
  // way everywhere: triple words at the corners and the middle of each
  // edge, and the same double-word star at the centre.
  for (const [sx, sy] of boards()) {
    assert.equal(premiumAt(sx, sy), 'DW', `no star at ${sx},${sy}`);
    assert.equal(premiumAt(sx - 7, sy - 7), 'TW', `no corner at ${sx},${sy}`);
    assert.equal(premiumAt(sx - 7, sy), 'TW', `no edge star at ${sx},${sy}`);
    assert.equal(premiumAt(sx, sy - 7), 'TW', `no edge star at ${sx},${sy}`);
  }
});

test('no two triple-words touch, anywhere in the world', () => {
  // Two side by side would make a nine-times word out of a single play,
  // which is the classic board's ceiling — and the new layouts have to
  // keep clear of the rim's own to hold to it.
  let doubled = 0;
  for (let x = 0; x < WORLD; x++) {
    for (let y = 0; y < WORLD; y++) {
      if (premiumAt(x, y) !== 'TW') continue;
      if (premiumAt(x + 1, y) === 'TW' || premiumAt(x, y + 1) === 'TW') doubled++;
    }
  }
  assert.equal(doubled, 0);
});

test('every board pays about as well as a real one', () => {
  for (const [sx, sy] of boards()) {
    let premium = 0;
    for (let dx = -7; dx <= 6; dx++) {
      for (let dy = -7; dy <= 6; dy++) if (premiumAt(sx + dx, sy + dy)) premium++;
    }
    const density = premium / (PERIOD * PERIOD);
    assert.ok(
      density > 0.18 && density < 0.36,
      `${patternAt(sx, sy)} board at ${sx},${sy} runs at ${density.toFixed(3)}`,
    );
  }
});
