// Premium squares on the infinite plain.
//
// The classic scrabble board layout, tiled seamlessly forever and stretched
// to double scale so the criss-cross motifs breathe. The standard 15×15
// board is mirror-symmetric about its centre lines, and its last row and
// column repeat its first, so dropping them gives a 14×14 tile that
// reproduces the familiar pattern — triple-word corners, double-word
// diagonal X's, the triple/double-letter diamonds. Each premium sits two
// cells from its neighbours (SCALE = 2), which halves the density and
// widens the whole lattice.

// The tile has to divide the world for the pattern to close on itself, and
// the world is 512 cells — a power of two, which no multiple of the classic
// 15-square board can divide. So each board is laid out with a one-square
// gutter of plain cells along two of its sides: 15 + 1 = 16 squares, 32
// cells at double scale, and 512 / 32 = 16 boards across the torus. The
// gutter reads as the margin between boards laid side by side, and every
// board inside it is the genuine article.
const SCALE = 2;
const BOARD = 15; // the classic board, in classic squares
const TILE = BOARD + 1; // ...plus the gutter that makes the tiling close
export const PERIOD = TILE * SCALE;

const mod = (n, m) => ((n % m) + m) % m;

// One quadrant of the classic board (0..7 in both axes, 7 = board centre).
const QUADRANT = {
  '0,0': 'TW', '7,0': 'TW', '0,7': 'TW',
  '1,1': 'DW', '2,2': 'DW', '3,3': 'DW', '4,4': 'DW', '7,7': 'DW',
  '5,1': 'TL', '1,5': 'TL', '5,5': 'TL',
  '3,0': 'DL', '0,3': 'DL', '6,2': 'DL', '2,6': 'DL',
  '3,7': 'DL', '7,3': 'DL', '6,6': 'DL',
};

/**
 * Premium at integer cell (x, y).
 *
 * The tiling is offset so the origin — the start cell — sits on a board
 * centre (the double-word star), just like the first move in scrabble.
 *
 * @returns {'TW'|'DW'|'TL'|'DL'|null}
 */
export function premiumAt(x, y) {
  const px = mod(x, PERIOD);
  const py = mod(y, PERIOD);
  if (px % SCALE !== 0 || py % SCALE !== 0) return null;
  // Centre the board on the origin: the 15 squares either side of it are
  // the board, the 16th is the gutter between this board and the next.
  let u = mod(px / SCALE + 7, TILE);
  let v = mod(py / SCALE + 7, TILE);
  if (u >= BOARD || v >= BOARD) return null; // the gutter is always plain
  if (u > 7) u = 14 - u;
  if (v > 7) v = 14 - v;
  return QUADRANT[`${u},${v}`] ?? null;
}
