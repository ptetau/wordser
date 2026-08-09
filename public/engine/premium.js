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

// TILE 15 (the full classic board) at double scale gives period 30, which
// divides the 120-cell world evenly — the pattern loops seamlessly across
// the torus edges.
const SCALE = 2;
const TILE = 15;
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
  let u = mod(px / SCALE + 7, TILE);
  let v = mod(py / SCALE + 7, TILE);
  if (u > 7) u = 14 - u;
  if (v > 7) v = 14 - v;
  return QUADRANT[`${u},${v}`] ?? null;
}
