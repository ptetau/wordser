import { Game } from '../src/engine/game.js';
import { Dictionary } from '../src/engine/dictionary.js';
import { mulberry32 } from '../src/engine/tiles.js';

/** A game with a controlled dictionary, deterministic bag, and fixed racks. */
export function makeGame(words, { players = ['Ana', 'Ben'], racks, now } = {}) {
  const game = new Game({ dictionary: new Dictionary(words), rng: mulberry32(42), now });
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
