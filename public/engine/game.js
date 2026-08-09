// The wordser game: n-player scrabble on an infinite plain.
//
// House rules implemented here:
//   - Infinite board with a recurring criss-cross premium pattern (premium.js).
//   - Premiums count only for cells whose letter changed this move.
//   - You can only play after a friend has played: no player may make two
//     moves in a row (waived while the game has a single player).
//   - Steal: replace an existing word with a new real word of the same length.
//     Letters of the old word you don't reuse may be stolen into your rack up
//     to the rack maximum of 12; the rest are discarded.
//   - Mutate: swap one letter of an existing word for one of yours, provided
//     every word through that cell stays real. The ousted letter is yours if
//     your rack has room.
//   - Wildcard redefinition: a blank on the board may be reassigned to a new
//     letter to fit the word you are playing, provided every word through it
//     stays real.
//   - Scores reset every day; each day's winner(s) get a star by their name.

import { Board } from './board.js';
import { premiumAt } from './premium.js';
import { LETTER_VALUES, BLANK, Bag } from './tiles.js';

export const RACK_TARGET = 7;
export const RACK_MAX = 12;
export const BINGO_BONUS = 50;

export class GameError extends Error {}

const fail = (msg) => {
  throw new GameError(msg);
};

const isLetter = (s) => typeof s === 'string' && /^[a-z]$/.test(s);

function removeOne(rack, letter) {
  const i = rack.indexOf(letter);
  if (i === -1) return false;
  rack.splice(i, 1);
  return true;
}

export class Game {
  /**
   * @param {object} opts
   * @param {{has(word:string):boolean}} opts.dictionary
   * @param {() => number} [opts.rng] random source for the bag
   * @param {() => number} [opts.now] clock (ms epoch) for daily resets
   */
  constructor({ dictionary, rng, now } = {}) {
    if (!dictionary) fail('a dictionary is required');
    this.dictionary = dictionary;
    this.board = new Board();
    this.bag = new Bag(rng);
    this.players = [];
    this.lastPlayerId = null;
    this.day = 1;
    this.now = now ?? (() => Date.now());
    this.dateKey = this.#dateKey();
    this.log = [];
  }

  #dateKey() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  addPlayer(name) {
    const player = { id: this.players.length, name, rack: [], score: 0, stars: 0 };
    this.players.push(player);
    this.#refill(player);
    return player;
  }

  player(id) {
    return this.players[id] ?? fail(`no such player: ${id}`);
  }

  #refill(player) {
    while (player.rack.length < RACK_TARGET) player.rack.push(this.bag.draw());
  }

  #assertCanPlay(player) {
    if (this.players.length > 1 && this.lastPlayerId === player.id) {
      fail('you can only play after a friend has played');
    }
  }

  /** Award stars for the day that just ended, reset scores, start a new day. */
  startNewDay() {
    const best = Math.max(0, ...this.players.map((p) => p.score));
    const winners = best > 0 ? this.players.filter((p) => p.score === best) : [];
    for (const w of winners) w.stars += 1;
    if (winners.length) {
      this.log.push(`day ${this.day} won by ${winners.map((w) => w.name).join(', ')} (${best} pts) ★`);
    } else {
      this.log.push(`day ${this.day} ends with no winner`);
    }
    for (const p of this.players) p.score = 0;
    this.day += 1;
    this.lastPlayerId = null;
    this.dateKey = this.#dateKey();
    return winners;
  }

  /** Roll the day over if the clock has moved past it. Returns true if it did. */
  rolloverIfNeeded() {
    if (this.#dateKey() !== this.dateKey) {
      this.startNewDay();
      return true;
    }
    return false;
  }

  #maybeRollover() {
    this.rolloverIfNeeded();
  }

  #checkWordsThrough(x, y) {
    for (const dir of ['h', 'v']) {
      const w = this.board.wordThrough(x, y, dir);
      if (w && w.cells.length >= 2 && !this.dictionary.has(w.word)) {
        fail(`"${w.word}" is not a real word`);
      }
    }
  }

  #scoreWord(cells, changed) {
    let sum = 0;
    let mult = 1;
    for (const c of cells) {
      let v = c.tile.isBlank ? 0 : LETTER_VALUES[c.tile.letter];
      if (changed.has(Board.key(c.x, c.y))) {
        const p = premiumAt(c.x, c.y);
        if (p === 'DL') v *= 2;
        else if (p === 'TL') v *= 3;
        else if (p === 'DW') mult *= 2;
        else if (p === 'TW') mult *= 3;
      }
      sum += v;
    }
    return sum * mult;
  }

  #commit(player, points, message) {
    player.score += points;
    this.lastPlayerId = player.id;
    this.#refill(player);
    this.log.push(`${player.name}: ${message} (+${points})`);
  }

  /**
   * Standard placement move, optionally redefining wildcards it crosses.
   *
   * @param {object} m
   * @param {number} m.playerId
   * @param {{x:number, y:number, letter:string, fromBlank?:boolean}[]} m.tiles
   *   letter is the effective letter to show; fromBlank spends a rack blank.
   * @param {{x:number, y:number, as:string}[]} [m.redefinitions]
   *   wildcards already on the board to reassign so they fit the new word.
   */
  place({ playerId, tiles, redefinitions = [] }) {
    this.#maybeRollover();
    const player = this.player(playerId);
    this.#assertCanPlay(player);

    if (!Array.isArray(tiles) || tiles.length === 0) fail('no tiles to place');
    const boardWasEmpty = this.board.isEmpty();

    // Rack availability.
    const rackCopy = [...player.rack];
    for (const t of tiles) {
      if (!isLetter(t.letter)) fail(`invalid letter: ${t.letter}`);
      const need = t.fromBlank ? BLANK : t.letter;
      if (!removeOne(rackCopy, need)) {
        fail(t.fromBlank ? 'no blank tile in your rack' : `no "${t.letter}" in your rack`);
      }
    }

    // Distinct, empty target cells on one line.
    const keys = new Set(tiles.map((t) => Board.key(t.x, t.y)));
    if (keys.size !== tiles.length) fail('duplicate target cell');
    for (const t of tiles) {
      if (this.board.get(t.x, t.y)) fail(`cell (${t.x},${t.y}) is already occupied`);
    }
    const sameRow = tiles.every((t) => t.y === tiles[0].y);
    const sameCol = tiles.every((t) => t.x === tiles[0].x);
    if (!sameRow && !sameCol) fail('tiles must be placed in a single row or column');
    const dir = sameRow && (tiles.length > 1 || !sameCol) ? 'h' : 'v';

    // Tentatively apply; anything below that fails must revert.
    const placed = [];
    const redefined = [];
    try {
      for (const t of tiles) {
        const tile = t.fromBlank ? { isBlank: true, as: t.letter } : { letter: t.letter };
        this.board.set(t.x, t.y, tile);
        placed.push(t);
      }

      for (const r of redefinitions) {
        const tile = this.board.get(r.x, r.y);
        if (!tile) fail(`no tile at (${r.x},${r.y}) to redefine`);
        if (!tile.isBlank) fail('only wildcards can be redefined');
        if (!isLetter(r.as)) fail(`invalid redefinition letter: ${r.as}`);
        if (keys.has(Board.key(r.x, r.y))) fail('cannot redefine a tile placed this turn');
        redefined.push({ x: r.x, y: r.y, was: tile.as });
        tile.as = r.as;
      }

      // No gaps: every cell of the main line between the extremes is filled.
      const xs = tiles.map((t) => t.x);
      const ys = tiles.map((t) => t.y);
      if (dir === 'h') {
        for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
          if (!this.board.get(x, tiles[0].y)) fail('placed tiles leave a gap');
        }
      } else {
        for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
          if (!this.board.get(tiles[0].x, y)) fail('placed tiles leave a gap');
        }
      }

      // Collect formed words: maximal runs through each new tile.
      const seen = new Set();
      const formed = [];
      for (const t of tiles) {
        for (const d of ['h', 'v']) {
          const w = this.board.wordThrough(t.x, t.y, d);
          if (!w || w.cells.length < 2) continue;
          const id = `${d}:${w.cells[0].x},${w.cells[0].y}`;
          if (seen.has(id)) continue;
          seen.add(id);
          formed.push(w);
        }
      }
      const formedCellKeys = new Set(
        formed.flatMap((w) => w.cells.map((c) => Board.key(c.x, c.y))),
      );

      // Every new tile must be part of a real word...
      for (const t of tiles) {
        if (!formedCellKeys.has(Board.key(t.x, t.y))) {
          fail('every placed tile must be part of a word of two or more letters');
        }
      }
      // ...and the play must connect to the existing board (unless it's empty).
      if (!boardWasEmpty) {
        const connects = formed.some((w) =>
          w.cells.some((c) => !keys.has(Board.key(c.x, c.y))),
        );
        if (!connects) fail('the word must connect to tiles already on the board');
      }

      for (const w of formed) {
        if (!this.dictionary.has(w.word)) fail(`"${w.word}" is not a real word`);
      }

      // Redefinitions must fit the word being played, and every word through
      // the redefined wildcard must stay real.
      for (const r of redefined) {
        if (!formedCellKeys.has(Board.key(r.x, r.y))) {
          fail('a wildcard may only be redefined to fit the word you are playing');
        }
        this.#checkWordsThrough(r.x, r.y);
      }

      const changed = new Set(tiles.map((t) => Board.key(t.x, t.y)));
      let points = formed.reduce((acc, w) => acc + this.#scoreWord(w.cells, changed), 0);
      if (tiles.length >= RACK_TARGET) points += BINGO_BONUS;

      player.rack = rackCopy;
      const main = formed.find((w) => w.dir === dir) ?? formed[0];
      this.#commit(player, points, `played "${main.word.toUpperCase()}"`);
      return { points, words: formed.map((w) => w.word) };
    } catch (err) {
      for (const t of placed) this.board.remove(t.x, t.y);
      for (const r of redefined) {
        const tile = this.board.get(r.x, r.y);
        if (tile?.isBlank) tile.as = r.was;
      }
      throw err;
    }
  }

  /**
   * Steal move: replace an existing word (the maximal run through (x, y) in
   * dir) with your own real word laid along the same line. The new word may
   * be shorter or longer than the old one; `offset` says where it starts
   * relative to the old word's first cell (it must overlap the old word, and
   * the old word is removed entirely). Old letters you reuse stay on the
   * board; old letters you don't reuse are stolen into your rack up to the
   * RACK_MAX of 12 tiles, and the rest are discarded.
   */
  stealReplace({ playerId, x, y, dir, word, offset = 0 }) {
    this.#maybeRollover();
    const player = this.player(playerId);
    this.#assertCanPlay(player);

    const existing = this.board.wordThrough(x, y, dir) ?? fail('no word there');
    const oldLen = existing.cells.length;
    if (oldLen < 2) fail('no word there');
    const newWord = String(word ?? '').toLowerCase();
    if (!/^[a-z]{2,}$/.test(newWord)) fail('invalid replacement word');
    if (!Number.isInteger(offset)) fail('invalid offset');
    const L = newWord.length;
    if (offset >= oldLen || offset + L <= 0) fail('the new word must overlap the word it replaces');
    if (offset === 0 && L === oldLen && newWord === existing.word) {
      fail('the replacement must be a different word');
    }
    if (!this.dictionary.has(newWord)) fail(`"${newWord}" is not a real word`);

    const dx = dir === 'h' ? 1 : 0;
    const dy = dir === 'h' ? 0 : 1;
    const cross = dir === 'h' ? 'v' : 'h';
    const start = existing.cells[0];
    const spanCell = (i) => ({ x: start.x + (offset + i) * dx, y: start.y + (offset + i) * dy });

    // Span cells outside the old word must be empty; adjacent cells along the
    // line must end up empty so the new word is exactly the maximal run.
    for (let i = 0; i < L; i++) {
      const idx = offset + i;
      if (idx < 0 || idx >= oldLen) {
        const c = spanCell(i);
        if (this.board.get(c.x, c.y)) fail(`cell (${c.x},${c.y}) is already occupied`);
      }
    }
    for (const idx of [offset - 1, offset + L]) {
      if (idx >= 0 && idx < oldLen) continue; // an old cell: vacated or replaced
      const cx = start.x + idx * dx;
      const cy = start.y + idx * dy;
      if (this.board.get(cx, cy)) fail('the new word would run into another word on the same line');
    }

    // Keep old tiles whose cell keeps its letter; pool the rest for reuse.
    const pool = [];
    const newTiles = new Array(L);
    existing.cells.forEach((c, i) => {
      const j = i - offset;
      if (j >= 0 && j < L && Board.effective(c.tile) === newWord[j]) newTiles[j] = c.tile;
      else pool.push(c.tile);
    });

    // Source the rest: old exact letter, then rack letter, then an old
    // wildcard, then a rack blank.
    const rackCopy = [...player.rack];
    for (let j = 0; j < L; j++) {
      if (newTiles[j]) continue;
      const letter = newWord[j];
      const exact = pool.findIndex((t) => !t.isBlank && t.letter === letter);
      if (exact !== -1) {
        newTiles[j] = pool.splice(exact, 1)[0];
      } else if (removeOne(rackCopy, letter)) {
        newTiles[j] = { letter };
      } else {
        const wild = pool.findIndex((t) => t.isBlank);
        if (wild !== -1) {
          pool.splice(wild, 1);
          newTiles[j] = { isBlank: true, as: letter };
        } else if (removeOne(rackCopy, BLANK)) {
          newTiles[j] = { isBlank: true, as: letter };
        } else {
          fail(`no way to form "${newWord}": missing "${letter}"`);
        }
      }
    }

    // Apply: vacate old cells outside the span, lay the new word.
    const vacated = [];
    existing.cells.forEach((c, i) => {
      const j = i - offset;
      if (j < 0 || j >= L) {
        this.board.remove(c.x, c.y);
        vacated.push(c);
      }
    });
    const changed = new Set();
    for (let j = 0; j < L; j++) {
      const c = spanCell(j);
      const idx = offset + j;
      const before = idx >= 0 && idx < oldLen ? existing.cells[idx].tile : null;
      if (newTiles[j] !== before) changed.add(Board.key(c.x, c.y));
      this.board.set(c.x, c.y, newTiles[j]);
    }

    const revert = () => {
      for (let j = 0; j < L; j++) {
        const c = spanCell(j);
        this.board.remove(c.x, c.y);
      }
      for (const c of existing.cells) this.board.set(c.x, c.y, c.tile);
    };

    try {
      // Cross-words at every changed cell must be real.
      for (let j = 0; j < L; j++) {
        const c = spanCell(j);
        if (!changed.has(Board.key(c.x, c.y))) continue;
        const w = this.board.wordThrough(c.x, c.y, cross);
        if (w && w.cells.length >= 2 && !this.dictionary.has(w.word)) {
          fail(`"${w.word}" is not a real word`);
        }
      }
      // Removing letters must not break the words that crossed them: each
      // remaining perpendicular fragment must be a real word, and no tile may
      // be left stranded outside any word.
      const px = dir === 'h' ? 0 : 1;
      const py = dir === 'h' ? 1 : 0;
      for (const v of vacated) {
        for (const side of [-1, 1]) {
          const nx = v.x + side * px;
          const ny = v.y + side * py;
          if (!this.board.get(nx, ny)) continue;
          const w = this.board.wordThrough(nx, ny, cross);
          if (w.cells.length >= 2) {
            if (!this.dictionary.has(w.word)) fail(`"${w.word}" is not a real word`);
          } else {
            const other = this.board.wordThrough(nx, ny, dir);
            if (!other || other.cells.length < 2) {
              fail('that would leave a stranded letter on the board');
            }
          }
        }
      }
    } catch (err) {
      revert();
      throw err;
    }

    // Steal leftovers up to the rack cap; discard the rest.
    let stolen = 0;
    let discarded = 0;
    for (const t of pool) {
      if (rackCopy.length < RACK_MAX) {
        rackCopy.push(t.isBlank ? BLANK : t.letter);
        stolen += 1;
      } else {
        discarded += 1;
      }
    }
    player.rack = rackCopy;

    const main = this.board.wordThrough(spanCell(0).x, spanCell(0).y, dir);
    let points = this.#scoreWord(main.cells, changed);
    for (const c of main.cells) {
      if (!changed.has(Board.key(c.x, c.y))) continue;
      const w = this.board.wordThrough(c.x, c.y, cross);
      if (w && w.cells.length >= 2) points += this.#scoreWord(w.cells, changed);
    }

    this.#commit(
      player,
      points,
      `stole "${existing.word.toUpperCase()}" → "${newWord.toUpperCase()}"` +
        (stolen ? `, took ${stolen} letter${stolen === 1 ? '' : 's'}` : '') +
        (discarded ? `, discarded ${discarded}` : ''),
    );
    return { points, stolen, discarded, word: newWord };
  }

  /**
   * Mutate move: swap one letter of an existing word for a tile from your
   * rack. Every word through the cell must stay real. The replaced tile joins
   * your rack if there's room (max RACK_MAX), otherwise it's discarded.
   */
  mutate({ playerId, x, y, letter, fromBlank = false }) {
    this.#maybeRollover();
    const player = this.player(playerId);
    this.#assertCanPlay(player);

    const old = this.board.get(x, y) ?? fail('no tile there');
    if (!isLetter(letter)) fail(`invalid letter: ${letter}`);
    if (Board.effective(old) === letter) fail('that would not change the word');

    const rackCopy = [...player.rack];
    const need = fromBlank ? BLANK : letter;
    if (!removeOne(rackCopy, need)) {
      fail(fromBlank ? 'no blank tile in your rack' : `no "${letter}" in your rack`);
    }

    const tile = fromBlank ? { isBlank: true, as: letter } : { letter };
    this.board.set(x, y, tile);
    try {
      const words = ['h', 'v']
        .map((d) => this.board.wordThrough(x, y, d))
        .filter((w) => w && w.cells.length >= 2);
      if (words.length === 0) fail('that tile is not part of a word');
      for (const w of words) {
        if (!this.dictionary.has(w.word)) fail(`"${w.word}" is not a real word`);
      }

      if (rackCopy.length < RACK_MAX) rackCopy.push(old.isBlank ? BLANK : old.letter);
      player.rack = rackCopy;

      const changed = new Set([Board.key(x, y)]);
      const points = words.reduce((acc, w) => acc + this.#scoreWord(w.cells, changed), 0);
      this.#commit(
        player,
        points,
        `mutated ${words.map((w) => `"${w.word.toUpperCase()}"`).join(' & ')}`,
      );
      return { points, words: words.map((w) => w.word) };
    } catch (err) {
      this.board.set(x, y, old);
      throw err;
    }
  }

  /** Dispatch a move described as plain data (used by the network server). */
  apply(move) {
    switch (move?.type) {
      case 'place':
        return this.place(move);
      case 'steal':
        return this.stealReplace(move);
      case 'mutate':
        return this.mutate(move);
      default:
        fail(`unknown move type: ${move?.type}`);
    }
  }

  /** Plain-data snapshot of the full game state. */
  toJSON() {
    return {
      day: this.day,
      dateKey: this.dateKey,
      lastPlayerId: this.lastPlayerId,
      players: this.players.map((p) => ({ ...p, rack: [...p.rack] })),
      cells: [...this.board.cells.entries()].map(([k, tile]) => {
        const [x, y] = k.split(',').map(Number);
        return { x, y, ...tile };
      }),
      log: [...this.log],
    };
  }

  /** Rebuild a game from a toJSON() snapshot. */
  static fromJSON(data, { dictionary, rng, now } = {}) {
    const game = new Game({ dictionary, rng, now });
    game.day = data.day;
    game.dateKey = data.dateKey;
    game.lastPlayerId = data.lastPlayerId;
    game.players = data.players.map((p) => ({ ...p, rack: [...p.rack] }));
    for (const { x, y, ...tile } of data.cells) game.board.set(x, y, tile);
    game.log = [...(data.log ?? [])];
    return game;
  }
}
