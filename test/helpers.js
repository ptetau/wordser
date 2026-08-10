import { Game } from '../public/engine/game.js';
import { Dictionary } from '../public/engine/dictionary.js';
import { mulberry32 } from '../public/engine/tiles.js';

/** A game with a controlled dictionary, deterministic bag, and fixed racks. */
export function makeGame(words, { players = ['Ana', 'Ben'], racks, now, mode = 'free' } = {}) {
  const game = new Game({ dictionary: new Dictionary(words), rng: mulberry32(42), now });
  // Rule tests care about words, not whose go it is, so the fixture opens in
  // free-for-all. Pass mode: 'turns' to exercise the rotation new games get.
  game.mode = mode;
  game.fruits.clear(); // tests place fruits deliberately
  players.forEach((name) => game.addPlayer(name));
  if (racks) racks.forEach((rack, i) => (game.players[i].rack = [...rack]));
  return game;
}

/** Place a whole horizontal word of fresh tiles for player 0-style setup. */
export function tilesFor(word, x, y, dir = 'h') {
  return [...word].map((letter, i) => ({
    x: x + (dir === 'h' ? i : 0),
    y: y + (dir === 'v' ? i : 0),
    letter,
  }));
}
