// Premium squares on the infinite plain.
//
// A recurring criss-cross lattice: premium dots run along both diagonal
// families of the grid, expressed in diagonal coordinates u = x+y and
// v = x-y (u and v always share the same parity).
//
//   - Word diagonals: the lines u ≡ 0 and v ≡ 0 (mod 12). Where two cross:
//     triple word. Half-way between crossings: double word, with triple
//     letter where two of those half-way lines meet.
//   - Letter diagonals: the odd lines u ≡ 3 and v ≡ 3 (mod 6), running
//     between the word diagonals, dotted with double letters.
//
// The pattern repeats with period PERIOD in both x and y.

export const PERIOD = 12;

const mod = (n, m) => ((n % m) + m) % m;

/**
 * Premium at integer cell (x, y).
 * @returns {'TW'|'DW'|'TL'|'DL'|null}
 */
export function premiumAt(x, y) {
  const u = mod(x + y, PERIOD);
  const v = mod(x - y, PERIOD);
  if (u === 0 && v === 0) return 'TW';
  if ((u === 0 && v === 6) || (u === 6 && v === 0)) return 'DW';
  if (u === 6 && v === 6) return 'TL';
  if (u % 6 === 3 && v % 6 === 3) return 'DL';
  return null;
}
