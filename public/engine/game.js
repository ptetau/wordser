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

import { Board, WORLD, wrapCoord, DIRS, DIR_NAMES } from './board.js';
import { premiumAt, PERIOD } from './premium.js';
import { LETTER_VALUES, BLANK, Bag } from './tiles.js';

export const RACK_TARGET = 7;
export const RACK_MAX = 12;
export const BINGO_BONUS = 50;
export const DAY_END_VOTE_MS = 2 * 60 * 1000;

// The first word of a game must cover the start cell, which always sits on
// a double-word star of the premium tiling. It begins at the origin and
// wanders to a different star every new day.
export const START_CELL = { x: 0, y: 0 };

// Bonus fruits appear on empty cells near the action, pac-man style. Cover
// one with a newly placed tile to eat it.
export const FRUIT_EMOJI = {
  lemon: '🍋', cherry: '🍒', chilli: '🌶️', grape: '🍇', banana: '🍌', kiwi: '🥝',
};
const FRUIT_TABLE = [
  ['lemon', 0.22], ['cherry', 0.18], ['chilli', 0.15],
  ['grape', 0.15], ['banana', 0.15], ['kiwi', 0.15],
];
const FRUIT_CHANCE = 0.6;
const MAX_FRUITS = 12;
const INITIAL_FRUITS = 12;
const FRUIT_RADIUS = 4;
const FRUIT_SPACING = 6; // min toroidal distance between fruits mid-game
const INITIAL_SPACING = 14; // min spread for the opening scatter
const CHERRY_CHOICES = 7;
const FIERY_LETTERS = ['j', 'q', 'x', 'z'];
const GRAPE_POINTS = 10;

export class GameError extends Error {}

const fail = (msg) => {
  throw new GameError(msg);
};

const isLetter = (s) => typeof s === 'string' && /^[a-z]$/.test(s);

/** Names collide if they match once case and stray spacing are ignored. */
const normalizeName = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

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
    this.fruits = new Map(); // "x,y" -> fruit type, always on empty cells
    this.bag = new Bag(rng);
    this.lastMove = null; // { playerId, keys } of the most recent board change
    this.startCell = { ...START_CELL };
    this.#seedFruits();
    this.players = [];
    this.adminId = null; // the seat that may remove players and pass this on
    this.lastPlayerId = null;
    this.passed = new Set(); // players who passed since the last real move
    this.dayEndVote = null; // { proposer, agreed: [ids], expiresAt } while voting
    this.day = 1;
    this.now = now ?? (() => Date.now());
    this.dateKey = this.#dateKey();
    this.log = [];
  }

  #dateKey() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** True if someone in the game already answers to this name. */
  nameTaken(name) {
    const key = normalizeName(name);
    return this.players.some((p) => normalizeName(p.name) === key);
  }

  /**
   * Seat a player. Names are distinct (ignoring case and stray spacing) so
   * the scoreboard, the log and "whose turn is it" all stay unambiguous.
   */
  addPlayer(name) {
    const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!clean) fail('a player name is required');
    if (this.nameTaken(clean)) fail(`${clean} is already playing — pick another name`);
    const player = { id: this.players.length, name: clean, rack: [], score: 0, stars: 0 };
    this.players.push(player);
    this.#refill(player);
    this.adminId ??= player.id; // whoever gets here first runs the game
    return player;
  }

  /** Seat a computer player under the first free "Robo N 🤖" name. */
  addCpu() {
    let n = 1;
    while (this.nameTaken(`Robo ${n} 🤖`)) n++;
    const cpu = this.addPlayer(`Robo ${n} 🤖`);
    cpu.isCpu = true;
    // A CPU can't run the game; the next human to arrive takes it on.
    if (this.adminId === cpu.id) this.adminId = null;
    return cpu;
  }

  /** True if this seat holds the game's admin rights. */
  isAdmin(playerId) {
    return this.adminId != null && this.adminId === playerId;
  }

  #assertAdmin(playerId) {
    if (!this.isAdmin(playerId)) fail('only the game admin can do that');
  }

  /**
   * Hand admin rights to somebody else. CPU seats can't hold them — nobody
   * would ever be able to use them again.
   */
  transferAdmin({ playerId, toId }) {
    this.#maybeRollover();
    this.#assertAdmin(playerId);
    const target = this.player(toId);
    if (target.id === playerId) fail('you are already the admin');
    if (target.isCpu) fail('a CPU player cannot be the admin');
    this.adminId = target.id;
    this.log.push(`${this.player(playerId).name} handed admin to ${target.name} 👑`);
    return { admin: target.id };
  }

  /**
   * Remove a player from the game. Their tiles rejoin today's bag, and every
   * seat after theirs shifts up so ids stay array indices — the returned
   * `map` takes an old id to its new one (null for the player who left) for
   * callers holding ids of their own.
   */
  removePlayer({ playerId, targetId }) {
    this.#maybeRollover();
    this.#assertAdmin(playerId);
    const target = this.player(targetId);
    if (target.id === playerId) {
      fail('the admin cannot remove themselves — hand admin over first');
    }
    const gone = target.id;
    const remap = (id) => (id == null || id === gone ? null : id > gone ? id - 1 : id);
    const map = this.players.map((_, i) => remap(i));

    this.bag.pool.push(...target.rack); // their letters go back in today's bag
    this.players.splice(gone, 1);
    this.players.forEach((p, i) => (p.id = i));
    this.adminId = remap(this.adminId);
    this.lastPlayerId = remap(this.lastPlayerId);
    this.passed = new Set([...this.passed].map(remap).filter((id) => id !== null));
    if (this.lastMove && this.lastMove.playerId === gone) this.lastMove.playerId = null;
    this.log.push(`${target.name} was removed from the game`);

    if (this.dayEndVote) {
      if (this.dayEndVote.proposer === gone) {
        this.dayEndVote = null;
        this.log.push('their proposal to end the day went with them — play on');
      } else {
        this.dayEndVote.proposer = remap(this.dayEndVote.proposer);
        this.dayEndVote.agreed = this.dayEndVote.agreed.map(remap).filter((id) => id !== null);
        // Removing a holdout can be the last vote a proposal was waiting on.
        if (this.dayEndVote.agreed.length >= this.players.length) {
          return { removed: target.name, map, ...this.#endDayByAgreement() };
        }
      }
    }
    return { removed: target.name, map, dayEnded: false };
  }

  player(id) {
    return this.players[id] ?? fail(`no such player: ${id}`);
  }

  #refill(player) {
    while (player.rack.length < RACK_TARGET) {
      const l = this.bag.draw();
      if (!l) break; // today's bag is dry
      player.rack.push(l);
    }
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
    // A brand-new bag for the new day, dealt before the fresh racks.
    this.bag.refill();
    for (const p of this.players) {
      p.score = 0;
      // A new day deals everyone a completely fresh rack.
      p.rack = [];
      delete p.pendingChoice;
      this.#refill(p);
    }
    // The start star wanders to a different double-word star.
    const stars = [];
    for (let x = 0; x < WORLD; x += PERIOD) {
      for (let y = 0; y < WORLD; y += PERIOD) {
        if (x !== this.startCell.x || y !== this.startCell.y) stars.push([x, y]);
      }
    }
    const [nx, ny] = stars[Math.floor(this.bag.rng() * stars.length)];
    this.startCell = { x: nx, y: ny };
    this.log.push(`the start star ★ moved and everyone drew a fresh rack`);
    this.day += 1;
    this.lastPlayerId = null;
    this.passed.clear();
    this.dayEndVote = null;
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

  /**
   * Resolve everything the clock owes us: the daily rollover, and a day-end
   * proposal whose response timer has run out. Returns true if state changed.
   */
  tickClock() {
    let changed = this.rolloverIfNeeded();
    if (this.dayEndVote && this.now() >= this.dayEndVote.expiresAt) {
      this.log.push('nobody objected in time — the day ends ⏳');
      this.startNewDay();
      changed = true;
    }
    return changed;
  }

  #maybeRollover() {
    this.tickClock();
  }

  #cancelDayVoteOnPlay(player) {
    if (this.dayEndVote) {
      this.dayEndVote = null;
      this.log.push(`${player.name} plays on — the day continues`);
    }
  }

  #checkWordsThrough(x, y) {
    for (const dir of DIR_NAMES) {
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

  #commit(player, points, message, coveredKeys = []) {
    player.score += points;
    this.lastPlayerId = player.id;
    this.passed.clear();
    this.#cancelDayVoteOnPlay(player);
    this.#refill(player);
    this.log.push(`${player.name}: ${message} (+${points})`);
    const fruits = this.#collectFruits(player, coveredKeys);
    this.spawnFruit(FRUIT_CHANCE, coveredKeys);
    return fruits;
  }

  #rollFruitType() {
    let r = this.bag.rng();
    let type = FRUIT_TABLE[FRUIT_TABLE.length - 1][0];
    for (const [t, weight] of FRUIT_TABLE) {
      if (r < weight) {
        type = t;
        break;
      }
      r -= weight;
    }
    return type;
  }

  /** Smallest toroidal chebyshev distance from (x, y) to any current fruit. */
  #fruitDistance(x, y) {
    let best = Infinity;
    for (const k of this.fruits.keys()) {
      const [fx, fy] = k.split(',').map(Number);
      const dx = Math.abs(wrapCoord(x) - fx);
      const dy = Math.abs(wrapCoord(y) - fy);
      const d = Math.max(Math.min(dx, WORLD - dx), Math.min(dy, WORLD - dy));
      best = Math.min(best, d);
    }
    return best;
  }

  /** Scatter the opening fruits across the world, well spread out. */
  #seedFruits() {
    for (let tries = 0; this.fruits.size < INITIAL_FRUITS && tries < 400; tries++) {
      const x = Math.floor(this.bag.rng() * WORLD);
      const y = Math.floor(this.bag.rng() * WORLD);
      if (x === this.startCell.x && y === this.startCell.y) continue;
      if (this.#fruitDistance(x, y) < INITIAL_SPACING) continue;
      this.fruits.set(Board.key(x, y), this.#rollFruitType());
    }
  }

  /**
   * Maybe drop a fruit on an empty cell near the action — anchored to the
   * cells of the move just played when given, so new fruit always appears
   * where players are looking, but never bunched against another fruit.
   * Tests can pass chance = 1 to force an attempt.
   */
  spawnFruit(chance = FRUIT_CHANCE, anchorKeys = []) {
    if (this.fruits.size >= MAX_FRUITS || this.board.isEmpty()) return null;
    if (this.bag.rng() >= chance) return null;
    const anchors = anchorKeys.length ? anchorKeys : [...this.board.cells.keys()];
    const [ax, ay] = anchors[Math.floor(this.bag.rng() * anchors.length)].split(',').map(Number);
    for (let tries = 0; tries < 12; tries++) {
      const x = ax + Math.floor(this.bag.rng() * (2 * FRUIT_RADIUS + 1)) - FRUIT_RADIUS;
      const y = ay + Math.floor(this.bag.rng() * (2 * FRUIT_RADIUS + 1)) - FRUIT_RADIUS;
      const k = Board.key(x, y);
      if (this.board.get(x, y) || this.fruits.has(k)) continue;
      if (this.#fruitDistance(x, y) < FRUIT_SPACING) continue;
      const type = this.#rollFruitType();
      this.fruits.set(k, type);
      this.log.push(`a ${type} ${FRUIT_EMOJI[type]} appeared`);
      return { x, y, type };
    }
    return null;
  }

  #collectFruits(player, keys) {
    const collected = [];
    for (const k of keys) {
      const type = this.fruits.get(k);
      if (!type) continue;
      this.fruits.delete(k);
      collected.push(type);
      if (type === 'lemon') {
        let n = 0;
        while (n < 2 && player.rack.length < RACK_MAX) {
          const l = this.bag.draw();
          if (!l) break;
          player.rack.push(l);
          n++;
        }
        this.log.push(`${player.name} ate a lemon ${FRUIT_EMOJI.lemon}: ${n} extra letter${n === 1 ? '' : 's'}`);
      } else if (type === 'chilli') {
        const letter = FIERY_LETTERS[Math.floor(this.bag.rng() * FIERY_LETTERS.length)];
        if (player.rack.length < RACK_MAX) player.rack.push(letter);
        this.log.push(`${player.name} ate a chilli ${FRUIT_EMOJI.chilli}: a fiery "${letter.toUpperCase()}"`);
      } else if (type === 'cherry') {
        const offered = Array.from({ length: CHERRY_CHOICES }, () => this.bag.draw()).filter(Boolean);
        if (offered.length) {
          player.pendingChoice = offered;
          this.log.push(`${player.name} ate a cherry ${FRUIT_EMOJI.cherry}: choose one of ${offered.length} letters`);
        } else {
          this.log.push(`${player.name} ate a cherry ${FRUIT_EMOJI.cherry}, but today's bag is empty`);
        }
      } else if (type === 'grape') {
        player.score += GRAPE_POINTS;
        this.log.push(`${player.name} ate a grape ${FRUIT_EMOJI.grape}: +${GRAPE_POINTS} points`);
      } else if (type === 'banana') {
        const n = player.rack.length;
        this.bag.pool.push(...player.rack);
        player.rack = Array.from({ length: n }, () => this.bag.draw()).filter(Boolean);
        this.log.push(`${player.name} ate a banana ${FRUIT_EMOJI.banana}: a fresh rack of ${player.rack.length}`);
      } else if (type === 'kiwi') {
        if (player.rack.length < RACK_MAX) player.rack.push(BLANK);
        this.log.push(`${player.name} ate a kiwi ${FRUIT_EMOJI.kiwi}: a wildcard`);
      }
    }
    return collected;
  }

  /**
   * Exchange move: swap some rack letters back into today's bag for fresh
   * ones, in place of making a word. Counts as your turn. Allowed only
   * while the bag still holds at least as many tiles as you give back.
   */
  exchange({ playerId, letters }) {
    this.#maybeRollover();
    const player = this.player(playerId);
    this.#assertCanPlay(player);
    if (!Array.isArray(letters) || letters.length < 1 || letters.length > RACK_TARGET) {
      fail('exchange between one and seven letters');
    }
    for (const l of letters) {
      if (!isLetter(l) && l !== BLANK) fail(`invalid letter: ${l}`);
    }
    if (this.bag.pool.length < letters.length) {
      fail("today's bag is too empty to exchange that many");
    }
    const rackCopy = [...player.rack];
    for (const l of letters) {
      if (!removeOne(rackCopy, l)) fail(`no "${l}" in your rack`);
    }
    const drawn = [];
    for (let i = 0; i < letters.length; i++) {
      const d = this.bag.draw();
      if (d) drawn.push(d);
    }
    rackCopy.push(...drawn);
    this.bag.pool.push(...letters);
    player.rack = rackCopy;
    this.lastPlayerId = player.id;
    this.passed.clear();
    this.#cancelDayVoteOnPlay(player);
    this.log.push(`${player.name}: exchanged ${letters.length} letter${letters.length === 1 ? '' : 's'} (+0)`);
    return { exchanged: letters.length, drawn: drawn.length, points: 0 };
  }

  /**
   * Propose ending the day. Only possible once today's bag is empty. Starts
   * a two-minute response window: any player may cancel (or simply play on),
   * and if everyone agrees — or nobody objects before the timer runs out —
   * the day ends. CPU players always agree. A lone player ends it at once.
   */
  proposeDayEnd({ playerId }) {
    this.#maybeRollover();
    const player = this.player(playerId);
    if (this.bag.pool.length > 0) fail('the day can only be ended once the bag is empty');
    if (this.dayEndVote) fail('a day-end proposal is already underway');
    const agreed = new Set([player.id]);
    for (const p of this.players) if (p.isCpu) agreed.add(p.id);
    this.dayEndVote = {
      proposer: player.id,
      agreed: [...agreed],
      expiresAt: this.now() + DAY_END_VOTE_MS,
    };
    this.log.push(`${player.name} proposes ending the day — 2 minutes to respond ⏳`);
    if (agreed.size >= this.players.length) return this.#endDayByAgreement();
    return { proposed: true, dayEnded: false, expiresAt: this.dayEndVote.expiresAt };
  }

  /** Respond to a day-end proposal: agree, or cancel it and play on. */
  voteDayEnd({ playerId, agree }) {
    this.#maybeRollover();
    const player = this.player(playerId);
    if (!this.dayEndVote) fail('no day-end proposal is underway');
    if (!agree) {
      this.dayEndVote = null;
      this.log.push(`${player.name} wants to keep playing — the day continues`);
      return { cancelled: true, dayEnded: false };
    }
    const agreed = new Set(this.dayEndVote.agreed);
    agreed.add(player.id);
    this.dayEndVote.agreed = [...agreed];
    this.log.push(`${player.name} agrees to end the day`);
    if (agreed.size >= this.players.length) return this.#endDayByAgreement();
    return { agreed: true, dayEnded: false };
  }

  #endDayByAgreement() {
    this.log.push('everyone agrees — the day ends');
    this.startNewDay();
    return { dayEnded: true };
  }

  /**
   * Pass move: give up the turn. When today's bag is empty and every player
   * has passed since the last real move, the day ends early — stars are
   * awarded, a fresh bag arrives, and racks are re-dealt.
   */
  pass({ playerId }) {
    this.#maybeRollover();
    const player = this.player(playerId);
    this.#assertCanPlay(player);
    this.lastPlayerId = player.id;
    this.passed.add(player.id);
    this.log.push(`${player.name}: passed`);
    if (this.bag.pool.length === 0 && this.passed.size >= this.players.length) {
      this.log.push('everyone passed on an empty bag — the day ends early');
      this.startNewDay();
      return { passed: true, dayEnded: true, points: 0 };
    }
    return { passed: true, dayEnded: false, points: 0 };
  }

  /**
   * Resolve a cherry: keep one of the offered letters. Not a play — it does
   * not consume your turn or require a friend to have moved.
   */
  choosePendingLetter({ playerId, index }) {
    const player = this.player(playerId);
    const choice = player.pendingChoice ?? fail('no letter choice is pending');
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= choice.length) fail('invalid choice');
    const letter = choice[i];
    delete player.pendingChoice;
    if (player.rack.length < RACK_MAX) player.rack.push(letter);
    this.log.push(`${player.name} kept "${letter.toUpperCase()}" from the cherry ${FRUIT_EMOJI.cherry}`);
    return { letter };
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
    const dir = tiles.every((t) => t.y === tiles[0].y)
      ? 'h'
      : tiles.every((t) => t.x === tiles[0].x)
        ? 'v'
        : fail('tiles must be placed in a single row or column');

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
      const [ddx, ddy] = DIRS[dir];
      const along = (t) => (dir === 'h' ? t.x : t.y);
      const first = tiles.reduce((a, t) => (along(t) < along(a) ? t : a));
      const span = Math.max(...tiles.map(along)) - along(first);
      for (let i = 0; i <= span; i++) {
        if (!this.board.get(first.x + i * ddx, first.y + i * ddy)) {
          fail('placed tiles leave a gap');
        }
      }

      // Collect formed words: maximal runs through each new tile.
      const seen = new Set();
      const formed = [];
      for (const t of tiles) {
        for (const d of DIR_NAMES) {
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
      // The first word of the game must cover the start cell.
      if (boardWasEmpty && !formedCellKeys.has(Board.key(this.startCell.x, this.startCell.y))) {
        fail('the first word must cover the start cell ★');
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
      this.lastMove = { playerId, keys: [...changed] };
      const fruits = this.#commit(player, points, `played "${main.word.toUpperCase()}"`, [...changed]);
      return { points, words: formed.map((w) => w.word), fruits };
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

    if (!DIRS[dir]) fail(`unknown direction: ${dir}`);
    const [dx, dy] = DIRS[dir];
    const crossDirs = DIR_NAMES.filter((d) => d !== dir);
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
        for (const cd of crossDirs) {
          const w = this.board.wordThrough(c.x, c.y, cd);
          if (w && w.cells.length >= 2 && !this.dictionary.has(w.word)) {
            fail(`"${w.word}" is not a real word`);
          }
        }
      }
      // Removing letters must not break the words that crossed them: each
      // remaining fragment on the other axes must be a real word, and no
      // tile may be left stranded outside any word.
      for (const v of vacated) {
        for (const cd of crossDirs) {
          const [cdx, cdy] = DIRS[cd];
          for (const side of [-1, 1]) {
            const nx = v.x + side * cdx;
            const ny = v.y + side * cdy;
            if (!this.board.get(nx, ny)) continue;
            const w = this.board.wordThrough(nx, ny, cd);
            if (w.cells.length >= 2) {
              if (!this.dictionary.has(w.word)) fail(`"${w.word}" is not a real word`);
            } else if (!DIR_NAMES.some((d) => (this.board.wordThrough(nx, ny, d)?.cells.length ?? 0) >= 2)) {
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
      for (const cd of crossDirs) {
        const w = this.board.wordThrough(c.x, c.y, cd);
        if (w && w.cells.length >= 2) points += this.#scoreWord(w.cells, changed);
      }
    }

    const coveredKeys = [];
    for (let j = 0; j < L; j++) {
      const idx = offset + j;
      if (idx < 0 || idx >= oldLen) {
        const c = spanCell(j);
        coveredKeys.push(Board.key(c.x, c.y));
      }
    }
    this.lastMove = { playerId, keys: [...changed] };
    const fruits = this.#commit(
      player,
      points,
      `stole "${existing.word.toUpperCase()}" → "${newWord.toUpperCase()}"` +
        (stolen ? `, took ${stolen} letter${stolen === 1 ? '' : 's'}` : '') +
        (discarded ? `, discarded ${discarded}` : ''),
      coveredKeys,
    );
    return { points, stolen, discarded, word: newWord, fruits };
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
      const words = DIR_NAMES
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
      this.lastMove = { playerId, keys: [Board.key(x, y)] };
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
      case 'exchange':
        return this.exchange(move);
      case 'pass':
        return this.pass(move);
      case 'proposeEnd':
        return this.proposeDayEnd(move);
      case 'voteEnd':
        return this.voteDayEnd(move);
      case 'choose':
        return this.choosePendingLetter(move);
      case 'kick':
        return this.removePlayer(move);
      case 'admin':
        return this.transferAdmin(move);
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
      adminId: this.adminId,
      players: this.players.map((p) => ({ ...p, rack: [...p.rack] })),
      cells: [...this.board.cells.entries()].map(([k, tile]) => {
        const [x, y] = k.split(',').map(Number);
        return { x, y, ...tile };
      }),
      fruits: [...this.fruits.entries()].map(([k, type]) => {
        const [x, y] = k.split(',').map(Number);
        return { x, y, type };
      }),
      lastMove: this.lastMove ? { playerId: this.lastMove.playerId, keys: [...this.lastMove.keys] } : null,
      startCell: { ...this.startCell },
      passed: [...this.passed],
      dayEndVote: this.dayEndVote ? { ...this.dayEndVote, agreed: [...this.dayEndVote.agreed] } : null,
      bag: [...this.bag.pool].sort().join(''),
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
    // Games saved before admin rights existed hand them to the first human.
    const firstHuman = game.players.findIndex((p) => !p.isCpu);
    game.adminId = data.adminId ?? (firstHuman === -1 ? null : firstHuman);
    for (const { x, y, ...tile } of data.cells) game.board.set(x, y, tile);
    game.fruits.clear(); // replace the constructor's fresh scatter with the snapshot's
    for (const { x, y, type } of data.fruits ?? []) game.fruits.set(Board.key(x, y), type);
    game.lastMove = data.lastMove ?? null;
    game.startCell = data.startCell ? { ...data.startCell } : { ...START_CELL };
    if (typeof data.bag === 'string') game.bag.pool = [...data.bag];
    game.passed = new Set(data.passed ?? []);
    game.dayEndVote = data.dayEndVote ? { ...data.dayEndVote, agreed: [...data.dayEndVote.agreed] } : null;
    game.log = [...(data.log ?? [])];
    return game;
  }
}
