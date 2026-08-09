// Premium squares on the infinite plain.
//
// A recurring criss-cross lattice: premium dots run along both diagonal
// families of the grid.
//
//   - Word diagonals: the lines x+y ≡ 0 and x-y ≡ 0 (mod 8). Where two
//     cross: triple word. Half-way between crossings: double word.
//   - Letter diagonals: the lines x+y ≡ 4 and x-y ≡ 4 (mod 8), running
//     between the word diagonals. Where two cross: triple letter; their
//     other dots: double letter.
//
// Every line is dotted (a premium every second cell along it), the whole
// pattern repeats with period PERIOD in both x and y, and overall premium
// density is close to a classic board's.

export const PERIOD = 8;

const mod = (n, m) => ((n % m) + m) % m;

/**
 * Premium at integer cell (x, y).
 * @returns {'TW'|'DW'|'TL'|'DL'|null}
 */
export function premiumAt(x, y) {
  const u = mod(x + y, PERIOD);
  const v = mod(x - y, PERIOD);
  if (u === 0 && v === 0) return 'TW';
  if (u === 0 || v === 0) return (u === 4 || v === 4) ? 'DW' : null;
  if (u === 4 && v === 4) return 'TL';
  if (u === 4 || v === 4) return (u % 4 === 2 || v % 4 === 2) ? 'DL' : null;
  return null;
}
