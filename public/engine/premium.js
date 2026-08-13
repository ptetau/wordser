// Premium squares: a world of scrabble boards, and not all of them classic.
//
// The world is tiled with 15×15 boards laid edge to edge. Their last row and
// column repeat their first, so the tile is 14 squares rather than 15 —
// neighbouring boards share one triple-word rim instead of each bringing
// their own and doubling it at the join. 14 divides the 448-cell world
// exactly 32 times, so the pattern meets itself at the seam as well.
//
// What changes from board to board is the *layout*. Every board is centred
// on a double-word star (the ★ the day opens on always lands on one), but
// the premiums around it are drawn by one of four hands:
//
//   classic  the real scrabble board, in full
//   spiral   an arm winding out from the star, worth more the further out
//   wave     ripples of letter bonuses running across the board
//   bag      a hoard around the star and plain felt around that
//
// Which hand draws which board is decided by a smooth field over the board
// lattice, so the map has regions of a dozen boards rather than a different
// one every time you cross a line — travelling turns the scenery over
// slowly, and it is worth knowing where the spirals are. Home (the board on
// the origin, where every new game opens) is always classic.
//
// Whatever the layout, three rules hold everywhere in the world, and the
// tests hold them to it:
//
//   - the centre of every board is a double-word star;
//   - no premium ever sits beside another, across or down. Two of them
//     under one letter's work is too cheap, and the real board never does
//     it either;
//   - no straight play can multiply a word by more than nine, which is the
//     classic board's own ceiling.
const BOARD = 15; // the classic board, in squares...
export const PERIOD = BOARD - 1; // ...minus the edge it shares with the next
/** Boards across the world. WORLD / PERIOD, pinned by the tests. */
export const WORLD_TILES = 32;
/** Boards to a region of one kind, give or take: the scenery's grain. */
const REGION = 4;
const TAU = Math.PI * 2;

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
 * Where a cell sits inside its own board: -7..6 from the star at its
 * centre. The rim between two boards belongs to exactly one of them, so no
 * cell is ever drawn twice.
 */
const offset = (n) => n - PERIOD * Math.round(n / PERIOD);

/** The line where two boards meet, in offsets from the star. */
const RIM = -PERIOD / 2;

/** Which board a cell belongs to: the star it is nearest. */
const boardOf = (n) => mod(Math.round(n / PERIOD), WORLD_TILES);

// ------------------------------------------------------------ the scenery

/** A stable number in [0,1) for a lattice point. No state, no seeding. */
function hash01(i, j) {
  let h = Math.imul(i + 0x9e37, 374761393) ^ Math.imul(j + 0x85eb, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const ease = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * A smooth, world-wrapping field over the board lattice: value noise with
 * REGION boards to a control point. Neighbouring boards read nearly the
 * same number, so the pattern they choose changes in slabs rather than at
 * random — the point of the exercise.
 */
function field(tx, ty) {
  const g = WORLD_TILES / REGION;
  const gx = Math.floor(tx / REGION);
  const gy = Math.floor(ty / REGION);
  const fx = ease((tx - gx * REGION) / REGION);
  const fy = ease((ty - gy * REGION) / REGION);
  const a = hash01(mod(gx, g), mod(gy, g));
  const b = hash01(mod(gx + 1, g), mod(gy, g));
  const c = hash01(mod(gx, g), mod(gy + 1, g));
  const d = hash01(mod(gx + 1, g), mod(gy + 1, g));
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

// The scenery in order, and how much of the world each kind covers. Classic
// keeps the lion's share: the strange boards are the interesting ones
// precisely because they are not everywhere.
const KINDS = ['classic', 'wave', 'spiral', 'bag'];
const SHARES = [0.46, 0.2, 0.2, 0.14];

/**
 * The whole map of the world's boards, worked out once.
 *
 * Two reasons to build the table rather than compute the field per cell.
 * The board is redrawn cell by cell every frame, and a table lookup is
 * free where four hashes and a bilinear blend are not. And ranking the
 * boards by their field value hands each kind exactly its share of the
 * world however lumpy the noise happens to be, while a threshold on the
 * raw value would leave it at the mercy of the distribution — the field is
 * smooth, so equal ranks still come out as regions rather than confetti.
 */
const PATTERN_MAP = (() => {
  const n = WORLD_TILES * WORLD_TILES;
  const values = new Float64Array(n);
  for (let ty = 0; ty < WORLD_TILES; ty++) {
    for (let tx = 0; tx < WORLD_TILES; tx++) values[ty * WORLD_TILES + tx] = field(tx, ty);
  }
  const order = [...values.keys()].sort((a, b) => values[a] - values[b]);
  const map = new Uint8Array(n);
  let at = 0;
  let taken = 0;
  SHARES.forEach((share, kind) => {
    taken += share;
    const upto = kind === SHARES.length - 1 ? n : Math.round(n * taken);
    for (; at < upto; at++) map[order[at]] = kind;
  });
  // Home is always the real thing: every new game opens on the origin star
  // and should open on a board people recognise.
  map[0] = 0;
  return map;
})();

/**
 * Which hand drew this board. Exported so the client can say where you are
 * and the tests can check the world holds some of each.
 *
 * @returns {'classic'|'spiral'|'wave'|'bag'}
 */
export function patternAt(x, y) {
  return KINDS[PATTERN_MAP[boardOf(y) * WORLD_TILES + boardOf(x)]];
}

// ------------------------------------------------------------ the layouts
//
// Each takes a cell's offset from its board's star and answers what sits
// there. Two rules bind all of them: the star itself is always a
// double-word, and no premium ever sits beside another.

/**
 * Nothing next to anything. Two premiums side by side pay twice over for
 * one letter's work, which is too cheap — and the real scrabble board never
 * does it either, which is why the classic layout needs no help here.
 *
 * The layouts below get it for nothing by keeping to the even squares:
 * orthogonal neighbours always differ in parity, so two of them can never
 * both be even. PERIOD is even, so an offset's parity is the world cell's
 * parity — the rule holds between boards and across the seam as much as
 * inside a board. Staying two cells clear of the rim covers the last case,
 * the rim being drawn classic and not on any one parity.
 */
const spaced = (dx, dy) =>
  (dx + dy) % 2 === 0 && Math.abs(dx) <= 5 && Math.abs(dy) <= 5;

function classic(dx, dy) {
  return QUADRANT[`${7 - Math.abs(dx)},${7 - Math.abs(dy)}`] ?? null;
}

/**
 * An arm winding out from the star, paying better the further out you
 * follow it — letters near the middle, word multipliers out at the end.
 * The arm keeps an even breadth however far out it gets, and the even
 * squares dot it rather than filling it.
 */
const SPIRAL_PITCH = 3.6; // cells between one turn of the arm and the next
const SPIRAL_WIDTH = 1.15; // ...and how broad a band the arm is drawn in
function spiral(dx, dy) {
  const r = Math.hypot(dx, dy);
  if (r < 0.5) return 'DW'; // the star
  if (!spaced(dx, dy)) return null;
  const phase = mod(Math.atan2(dy, dx) / TAU - r / SPIRAL_PITCH, 1);
  const arm = Math.min(phase, 1 - phase);
  // Phase runs both around the star and outward from it, so the window
  // that keeps the arm an even breadth however far out you follow it is
  // the one that scales with the gradient of the two together.
  const gradient = Math.hypot(1 / (TAU * r), 1 / SPIRAL_PITCH);
  if (arm > SPIRAL_WIDTH * gradient) return null;
  // Letters all the way out, and a word multiplier only every eighth
  // square: along any line at most one of those falls within a word's
  // length, so the most a play can pick up is one of them and one of the
  // rim's triple-words — nine times over, exactly the classic ceiling.
  const multiplies = (dx + dy) % 8 === 0;
  if (r > 4.6) return multiplies ? 'TW' : 'TL';
  if (r > 3.2) return multiplies ? 'DW' : 'TL';
  if (r > 1.8) return 'TL';
  return 'DL';
}

/**
 * Ripples: crests of letter bonuses running across the board, bent by a
 * slower swell down the other axis. Nothing but letters and the star — a
 * wave board is where you go to spend a Q. The crests are broad and the
 * even squares pick every other cell out of them, so a wave reads as a
 * dotted swell rather than a solid stripe.
 */
function wave(dx, dy) {
  if (dx === 0 && dy === 0) return 'DW';
  if (!spaced(dx, dy)) return null;
  const crest = Math.sin(dx * 0.86 + Math.sin(dy * 0.52) * 2.3);
  if (crest < -0.3) return null;
  if (crest > 0.86) return 'TL';
  return 'DL';
}

/**
 * A big bag: a hoard of letter bonuses packed around the star, with plain
 * felt all around it. Worth crossing the map for, and worth exactly once —
 * premiums pay the first letter to land on them and are ordinary board
 * ever after.
 *
 * Letters only, on purpose. Packing word multipliers this densely would
 * put three of them under one word and hand out scores no other board
 * could touch; a bag is where a Q pays, not where a word triples.
 */
const BAG_REACH = 5.6;
function bag(dx, dy) {
  const r = Math.hypot(dx, dy);
  if (r < 0.5) return 'DW'; // the star, as everywhere
  if (r > BAG_REACH || !spaced(dx, dy)) return null;
  return (dx + dy) % 4 === 0 ? 'TL' : 'DL';
}

const LAYOUTS = { classic, spiral, wave, bag };

/**
 * Premium at integer cell (x, y).
 *
 * The tiling is offset so the origin — the start cell — sits on a board
 * centre (the double-word star), just like the first move in scrabble, and
 * so does every other lattice point the ★ can move to.
 *
 * @returns {'TW'|'DW'|'TL'|'DL'|null}
 */
export function premiumAt(x, y) {
  const dx = offset(x);
  const dy = offset(y);
  if (dx === 0 && dy === 0) return 'DW'; // every board's star, whatever else
  // The rim is shared by two boards, so it belongs to neither of them: it
  // is drawn the classic way whatever they are. Every board is framed by
  // the same triple-word corners and edges, and the world reads as a grid
  // of boards however strange the insides get.
  if (dx === RIM || dy === RIM) return classic(dx, dy);
  return LAYOUTS[patternAt(x, y)](dx, dy);
}
