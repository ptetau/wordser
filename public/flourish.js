// What a word does when it lands.
//
// A two-point play and a fifty-point bingo should not arrive the same way.
// Each tier of score gets its own movement, and the letters take it in
// turn — a ripple down the word rather than the whole thing twitching at
// once, which is the difference between a flourish and a glitch.
//
// Every flourish is a transform around the tile's own centre, so nothing
// here changes what is drawn, only where. They all decay to nothing, and
// the caller stops asking once they have.

export const FLOURISH_MS = 1100;

/**
 * Which flourish a score earns. The thresholds are the shape of a real
 * game: most plays are single figures, twenty is a good word, fifty is a
 * bingo or a triple.
 */
export function flourishFor(points) {
  if (points >= 50) return 'dance';
  if (points >= 30) return 'spin';
  if (points >= 18) return 'warp';
  if (points >= 9) return 'shake';
  return 'wobble';
}

const TAU = Math.PI * 2;
/** Ease that starts strong and rings out, so the movement decays. */
const decay = (u) => (1 - u) ** 2;

/**
 * The transform for one tile of a flourishing word.
 *
 * @param {string} kind    from flourishFor()
 * @param {number} u       0..1 through the flourish
 * @param {number} i       the tile's place in the word, for the ripple
 * @param {number} c       cell size, so movement scales with the board
 * @returns {{dx:number, dy:number, rot:number, scale:number}}
 */
export function flourishAt(kind, u, i, c) {
  const still = { dx: 0, dy: 0, rot: 0, scale: 1 };
  if (u <= 0 || u >= 1) return still;
  // Each letter starts a beat after the one before it.
  const lag = i * 0.09;
  const t = (u - lag) / (1 - lag || 1);
  if (t <= 0) return still;
  const d = decay(t);

  switch (kind) {
    case 'wobble': // a nod: it happened, and that is all
      return { dx: 0, dy: -Math.sin(t * Math.PI) * c * 0.1, rot: Math.sin(t * TAU * 2) * 0.05 * d, scale: 1 + 0.04 * d };
    case 'shake': // pleased with itself
      return { dx: Math.sin(t * TAU * 3.5) * c * 0.09 * d, dy: -Math.sin(t * Math.PI) * c * 0.13, rot: 0, scale: 1 + 0.07 * d };
    case 'warp': // stretches as though pulled out of the board
      return {
        dx: 0,
        dy: -Math.sin(t * Math.PI) * c * 0.16,
        rot: Math.sin(t * TAU) * 0.1 * d,
        scale: 1 + Math.sin(t * Math.PI) * 0.22,
      };
    case 'spin': // one full turn, landing square
      return {
        dx: 0,
        dy: -Math.sin(t * Math.PI) * c * 0.2,
        rot: (1 - decay(t)) * TAU,
        scale: 1 + Math.sin(t * Math.PI) * 0.16,
      };
    case 'dance': // a bingo deserves the whole routine
      return {
        dx: Math.sin(t * TAU * 1.5) * c * 0.12 * d,
        dy: -Math.abs(Math.sin(t * TAU)) * c * 0.24 * (1 - t * 0.4),
        rot: Math.sin(t * TAU * 1.5) * 0.34 * d,
        scale: 1 + Math.sin(t * Math.PI * 2) * 0.18 * d,
      };
    default:
      return still;
  }
}
