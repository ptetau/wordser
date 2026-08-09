// A simple CPU opponent for local games.
//
// It looks for placements the honest way: enumerate candidate words that its
// rack can form (optionally through one letter already on the board), then
// let the rules engine validate — game.place() either commits the move or
// throws and reverts, so the engine itself is the referee.

import { Board } from './engine/board.js';
import { LETTER_VALUES, BLANK } from './engine/tiles.js';
import { GameError } from './engine/game.js';

const MAX_WORD_LEN = 5;
const MAX_ANCHORS = 24;
const MAX_ATTEMPTS = 600;

/** Short words the CPU will consider, sorted by raw letter value. */
export function buildWordList(dictionary) {
  return [...dictionary.words]
    .filter((w) => w.length >= 2 && w.length <= MAX_WORD_LEN)
    .sort((a, b) => value(b) - value(a));
}

const value = (word) => [...word].reduce((acc, c) => acc + (LETTER_VALUES[c] ?? 0), 0);

/**
 * Tiles to spell `word` from `rack`, using blanks for missing letters;
 * position skipIndex (a board letter) is left null. Returns null if the rack
 * can't cover it.
 */
function formable(word, rack, skipIndex = -1) {
  const counts = {};
  for (const l of rack) counts[l] = (counts[l] ?? 0) + 1;
  const tiles = [];
  for (let i = 0; i < word.length; i++) {
    if (i === skipIndex) {
      tiles.push(null);
      continue;
    }
    const ch = word[i];
    if (counts[ch] > 0) {
      counts[ch]--;
      tiles.push({ letter: ch });
    } else if (counts[BLANK] > 0) {
      counts[BLANK]--;
      tiles.push({ letter: ch, fromBlank: true });
    } else {
      return null;
    }
  }
  return tiles;
}

/**
 * Make one CPU move: resolve any pending cherry (keeping the highest-value
 * letter), then try to place a word. Returns the move result, or null when
 * no placement was found.
 */
export function takeCpuTurn(game, playerId, wordList, rng = Math.random) {
  const player = game.players[playerId];
  if (player.pendingChoice) {
    let best = 0;
    player.pendingChoice.forEach((l, i) => {
      if ((LETTER_VALUES[l] ?? 0) > (LETTER_VALUES[player.pendingChoice[best]] ?? 0)) best = i;
    });
    game.choosePendingLetter({ playerId, index: best });
  }
  const rack = player.rack;
  let attempts = 0;
  const tryPlace = (tiles) => {
    attempts++;
    try {
      return game.place({ playerId, tiles });
    } catch (err) {
      if (err instanceof GameError) return null;
      throw err;
    }
  };

  if (game.board.isEmpty()) {
    for (const w of wordList) {
      if (attempts >= MAX_ATTEMPTS) break;
      const tiles = formable(w, rack);
      if (!tiles) continue;
      const r = tryPlace(tiles.map((t, i) => ({ x: i, y: 0, ...t })));
      if (r) return r;
    }
    return null;
  }

  const anchors = [...game.board.cells.entries()].map(([k, tile]) => {
    const [x, y] = k.split(',').map(Number);
    return { x, y, letter: Board.effective(tile) };
  });
  for (let i = anchors.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [anchors[i], anchors[j]] = [anchors[j], anchors[i]];
  }

  for (const a of anchors.slice(0, MAX_ANCHORS)) {
    for (const w of wordList) {
      if (attempts >= MAX_ATTEMPTS) return null;
      let from = 0;
      for (let i = w.indexOf(a.letter); i !== -1; i = w.indexOf(a.letter, from)) {
        from = i + 1;
        const tiles = formable(w, rack, i);
        if (!tiles) continue;
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          // Cheap precheck: every other cell of the span must be empty.
          const cells = [];
          let ok = true;
          for (let j = 0; j < w.length; j++) {
            if (j === i) continue;
            const cx = a.x + (j - i) * dx;
            const cy = a.y + (j - i) * dy;
            if (game.board.get(cx, cy)) {
              ok = false;
              break;
            }
            cells.push({ x: cx, y: cy, ...tiles[j] });
          }
          if (!ok) continue;
          const r = tryPlace(cells);
          if (r) return r;
        }
      }
    }
  }
  return null;
}
