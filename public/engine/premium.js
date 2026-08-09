// Premium squares on the infinite plain.
//
// The classic scrabble board layout, tiled seamlessly forever. The standard
// 15×15 board is mirror-symmetric about its centre lines, and its last row
// and column repeat its first, so dropping them gives a 14×14 tile that
// reproduces the familiar pattern — triple-word corners, double-word
// diagonal X's, the triple/double-letter diamonds — continuously across the
// whole plane.

export const PERIOD = 14;

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
 * @returns {'TW'|'DW'|'TL'|'DL'|null}
 */
export function premiumAt(x, y) {
  let u = mod(x, PERIOD);
  let v = mod(y, PERIOD);
  if (u > 7) u = PERIOD - u;
  if (v > 7) v = PERIOD - v;
  return QUADRANT[`${u},${v}`] ?? null;
}
