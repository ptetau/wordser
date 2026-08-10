// Premium squares: the real scrabble board, tiled across the world.
//
// The real scrabble board, tiled edge to edge at its own scale: 15 squares
// across, which divides the 480-cell world exactly 32 times, so the pattern
// meets itself perfectly at the seam. Adjacent boards share their triple-word
// edges, the way two boards laid side by side on a table would.
const SCALE = 1;
const BOARD = 15; // the classic board, in squares
const TILE = BOARD;
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
  // Centre a board on the origin, then fold to the quadrant the layout is
  // stored in — the classic board is mirror-symmetric about both centres.
  let u = mod(px / SCALE + 7, TILE);
  let v = mod(py / SCALE + 7, TILE);
  if (u > 7) u = 14 - u;
  if (v > 7) v = 14 - v;
  return QUADRANT[`${u},${v}`] ?? null;
}
