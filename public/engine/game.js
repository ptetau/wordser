// The wordser game: n-player scrabble on a looping 448x448 world.
//
// House rules implemented here:
//   - A torus board with a recurring criss-cross premium pattern (premium.js).
//   - Premiums count only for cells whose letter changed this move.
//   - You can only play after a friend has played: nobody makes two moves in
//     a row, not even the only player at the table.
//   - Steal: replace an existing word with a new real word along the same
//     line. Letters of the old word you don't reuse may be stolen into your
//     rack up to the maximum of 12; the rest fall back into the bag.
//   - Mutate: swap one letter of an existing word for one of yours, provided
//     every word through that cell stays real. The ousted letter takes the
//     place of the tile you spent, so it always joins your rack.
//   - Every letter in play comes out of the day's 100-tile bag, and anything
//     that leaves a rack without reaching the board goes back into it.
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
/** Sit on your turn this long and the game plays on without you. */
export const IDLE_SKIP_MS = 8 * 60 * 60 * 1000;
/** How far the ★ jumps when the day's bag runs dry. */
export const STAR_JUMP = 20;

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
const DAILY_FRUITS = 10; // laid out each day, leaving room for fresh spawns
const FRUIT_RADIUS = 4;
const FRUIT_SPACING = 6; // min toroidal distance between fruits mid-game
const FRUIT_NEAR = 3; // never right under your nose...
const FRUIT_FAR = 9; // ...and never further than a couple of moves away
const DAILY_SPACING = 4; // min gap within the day's own scatter
const FOCAL_SAMPLES = 6; // board cells the day's fruit is arranged around
const CHERRY_CHOICES = 7;
const FIERY_LETTERS = ['j', 'q', 'x', 'z'];
const GRAPE_POINTS = 10;

/**
 * Whose move is it? Deliberately written against the plain fields rather
 * than a live game, so a caller holding only a stored snapshot — the games
 * menu, listing a dozen tables at once — asks exactly the same question the
 * engine will answer when the move arrives.
 *
 * @param {{players:Array, lastPlayerId:?number, mode:string, turnId:?number}} state
 */
export function turnBelongsTo(state, playerId) {
  if (!state.players?.length) return false;
  if (state.lastPlayerId === playerId) return false; // never twice running
  if (state.mode === 'turns') return state.turnId == null || state.turnId === playerId;
  return true;
}

/** The seat the game is waiting on, or null when anyone may go. */
export function waitingOn(state) {
  const candidates = (state.players ?? []).filter((p) => turnBelongsTo(state, p.id));
  return candidates.length === 1 ? candidates[0] : null;
}

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
    this.mode = 'turns'; // 'turns' = strict rotation, 'free' = free-for-all
    this.turnId = null; // whose turn it is, in 'turns' mode
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
    const player = {
      id: this.players.length, name: clean, rack: [], score: 0, stars: 0,
      lastActedAt: this.now(), // the idle clock starts when you sit down
      scored: [], // words this player has already been paid for today
    };
    this.players.push(player);
    this.#refill(player);
    this.adminId ??= player.id; // whoever gets here first runs the game
    if (this.turnId === null || this.turnId === undefined) {
      this.turnId = player.id;
      this.turnStartedAt = this.now();
    }
    this.#unstickTurn(); // a newcomer breaks a one-player deadlock
    this.log.push(`${clean} joined the game 👋`);
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

    // Every letter they were holding goes back into today's bag.
    this.#returnPendingChoice(target);
    this.bag.put(...target.rack);
    this.players.splice(gone, 1);
    this.players.forEach((p, i) => (p.id = i));
    this.adminId = remap(this.adminId);
    this.lastPlayerId = remap(this.lastPlayerId);
    // If it was their turn, it passes to whoever slid into their seat.
    this.turnId = this.turnId === gone
      ? (this.players.length ? gone % this.players.length : null)
      : remap(this.turnId);
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

  /**
   * May this player move? Under 'turns' the seat rotates and only the
   * player holding it may act. Under 'free' anyone may, so long as they
   * don't take two turns in a row — not even the only player at the table,
   * who has to find someone (or something) to play against.
   */
  #assertCanPlay(player) {
    if (this.mode === 'turns' && this.turnId !== null && this.turnId !== player.id) {
      fail(`it is ${this.player(this.turnId).name}'s turn`);
    }
    // Both modes keep the same promise: never two turns in a row. In a
    // rotation that only ever bites the player sitting alone, whose turn
    // comes straight back round to them.
    if (this.lastPlayerId !== player.id) return;
    fail(
      this.players.length > 1
        ? 'you can only play after a friend has played'
        : 'you have played — add a friend or a CPU player 🤖 to keep going',
    );
  }

  /** True if this player is the one the game is waiting on. */
  isTheirTurn(playerId) {
    return turnBelongsTo(this, playerId);
  }

  /** Hand the turn to the next seat along (a no-op in free-for-all). */
  #advanceTurn(fromId) {
    if (this.mode !== 'turns' || !this.players.length) return;
    const from = fromId ?? this.turnId ?? 0;
    this.turnId = (from + 1) % this.players.length;
    this.turnStartedAt = this.now();
  }

  /**
   * The rotation must never point at somebody who cannot legally move —
   * which happens the moment a second player joins a game where the turn
   * had cycled straight back to the one player who had just played.
   */
  #unstickTurn() {
    if (this.mode !== 'turns' || this.players.length < 2) return false;
    if (this.turnId === null || this.turnId !== this.lastPlayerId) return false;
    this.#advanceTurn(this.turnId);
    return true;
  }

  /** Note that a seat has just acted, for the idle clock. */
  #noteActed(player) {
    player.lastActedAt = this.now();
  }

  /**
   * Switch between strict rotation and free-for-all. The admin's call, and
   * it takes effect from the next move.
   */
  setMode({ playerId, mode }) {
    this.#maybeRollover();
    this.#assertAdmin(playerId);
    if (mode !== 'turns' && mode !== 'free') fail(`unknown mode: ${mode}`);
    if (this.mode === mode) return { mode };
    this.mode = mode;
    if (mode === 'turns') {
      // Pick up where play left off rather than jumping back to seat 0.
      this.turnId = this.lastPlayerId === null
        ? 0
        : (this.lastPlayerId + 1) % this.players.length;
      this.turnStartedAt = this.now();
    }
    this.log.push(
      mode === 'turns'
        ? 'the game now takes strict turns 🔁'
        : 'the game is now free-for-all — play whenever a friend has 🎲',
    );
    return { mode };
  }

  /**
   * Pass the turn on for somebody who isn't playing. The admin may do this
   * whenever, and the clock does it by itself once a player has sat on
   * their turn for IDLE_SKIP_MS.
   */
  skipTurn({ playerId, targetId, auto = false }) {
    if (!auto) {
      this.#maybeRollover();
      this.#assertAdmin(playerId);
    }
    if (this.mode !== 'turns') fail('there are no turns to skip in a free-for-all');
    const target = this.player(targetId ?? this.turnId ?? 0);
    if (this.turnId !== target.id) fail(`it is not ${target.name}'s turn to skip`);
    this.log.push(
      auto
        ? `${target.name} was away, so their turn passed ⏭`
        : `${target.name}'s turn was skipped`,
    );
    this.passed.add(target.id);
    this.lastPlayerId = target.id;
    this.#noteActed(target); // a skip restarts their idle clock
    this.#advanceTurn(target.id);
    if (this.bag.pool.length === 0 && this.passed.size >= this.players.length) {
      this.log.push('everyone passed on an empty bag — the day ends early');
      this.startNewDay();
      return { skipped: target.name, dayEnded: true };
    }
    return { skipped: target.name, dayEnded: false };
  }

  /**
   * Skip whoever has been sitting on their turn too long. The clock runs
   * from when they were handed the turn, not from when they last played —
   * somebody who waited all day for their go still gets their full eight
   * hours to take it.
   */
  skipIfIdle() {
    if (this.mode !== 'turns' || this.turnId === null || this.players.length < 2) return false;
    const waiting = this.players[this.turnId];
    if (!waiting || waiting.isCpu) return false;
    if (this.turnStartedAt == null) {
      this.turnStartedAt = this.now(); // start the clock on first sight
      return false;
    }
    if (this.now() - this.turnStartedAt < IDLE_SKIP_MS) return false;
    this.skipTurn({ targetId: waiting.id, auto: true });
    return true;
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
    // A brand-new 100-tile set for the new day, dealt before the fresh
    // racks. Yesterday's unplayed letters go with yesterday's bag — only
    // what reached the board outlives the day.
    this.bag.refill();
    this.starJumped = false;
    for (const p of this.players) {
      p.score = 0;
      p.scored = []; // yesterday's words pay again today
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
    // Yesterday's leftovers are scattered wherever yesterday's play went;
    // lay out a fresh crop within reach of today's.
    this.fruits.clear();
    this.#seedFruits();
    this.log.push(`the start star ★ moved and everyone drew a fresh rack`);
    this.log.push(`${this.fruits.size} fresh fruits are within reach 🍒`);
    this.day += 1;
    // lastPlayerId carries over: closing one day and opening the next is
    // still two turns in a row.
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
    if (this.#unstickTurn()) changed = true;
    if (this.skipIfIdle()) changed = true;
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

  /**
   * Have they already been paid for this word today? Swapping a letter back
   * and forth to re-score the same word is farming, not play, so each word
   * pays a given player once per day.
   */
  #alreadyScored(player, word) {
    return player.scored.includes(word);
  }

  #noteScored(player, words) {
    for (const w of words) if (!player.scored.includes(w)) player.scored.push(w);
  }

  /**
   * What this word pays this player: its face value the first time they
   * make it today, nothing after that.
   */
  #payFor(player, w, changed) {
    if (this.#alreadyScored(player, w.word)) return 0;
    return this.#scoreWord(w.cells, changed);
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
    this.#noteActed(player);
    this.#advanceTurn(player.id);
    this.passed.clear();
    this.#cancelDayVoteOnPlay(player);
    this.#refill(player);
    this.log.push(`${player.name}: ${message} (+${points})`);
    const fruits = this.#collectFruits(player, coveredKeys);
    this.spawnFruit(FRUIT_CHANCE, coveredKeys);
    this.#maybeJumpStar();
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

  /**
   * An empty bag ends the scramble for letters, so the ★ jumps at least
   * STAR_JUMP cells clear of where it was — a fresh mark on a board that
   * has been fought over all day. Once per day.
   */
  #maybeJumpStar() {
    if (this.starJumped || this.bag.pool.length > 0 || !this.players.length) return;
    this.starJumped = true;
    const far = [];
    for (let x = 0; x < WORLD; x += PERIOD) {
      for (let y = 0; y < WORLD; y += PERIOD) {
        const dx = Math.abs(x - this.startCell.x);
        const dy = Math.abs(y - this.startCell.y);
        const d = Math.max(Math.min(dx, WORLD - dx), Math.min(dy, WORLD - dy));
        if (d >= STAR_JUMP) far.push([x, y]);
      }
    }
    if (!far.length) return;
    const [nx, ny] = far[Math.floor(this.bag.rng() * far.length)];
    this.startCell = { x: nx, y: ny };
    this.log.push(`the bag is empty — the ★ moved somewhere new`);
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

  /**
   * The places today's play will revolve around: the ★, plus a scattering
   * of words already on the board (later days start on a busy board, and
   * the action follows the letters, not the star).
   */
  #focalPoints() {
    const points = [[this.startCell.x, this.startCell.y]];
    const cells = [...this.board.cells.keys()];
    for (let i = 0; i < FOCAL_SAMPLES && cells.length; i++) {
      const k = cells[Math.floor(this.bag.rng() * cells.length)];
      points.push(k.split(',').map(Number));
    }
    return points;
  }

  /**
   * Lay out the day's fruit within reach of the action: a ring around each
   * focal point, near enough that a player who goes after one can get there
   * in a move or two, far enough that they have to mean it. Called for a
   * fresh world and again at the start of every day.
   */
  #seedFruits() {
    const focals = this.#focalPoints();
    const rng = () => this.bag.rng();
    for (let tries = 0; this.fruits.size < DAILY_FRUITS && tries < 800; tries++) {
      const [fx, fy] = focals[Math.floor(rng() * focals.length)];
      // Pick how far out first, then a spot on that ring, so the crop is
      // spread evenly through the band instead of piling up at its edge.
      const r = FRUIT_NEAR + Math.floor(rng() * (FRUIT_FAR - FRUIT_NEAR + 1));
      const along = Math.floor(rng() * (2 * r + 1)) - r;
      const edge = rng() < 0.5 ? r : -r;
      const [dx, dy] = rng() < 0.5 ? [along, edge] : [edge, along];
      const x = wrapCoord(fx + dx);
      const y = wrapCoord(fy + dy);
      if (x === this.startCell.x && y === this.startCell.y) continue;
      if (this.board.get(x, y)) continue; // fruit only sits on empty cells
      if (this.#fruitDistance(x, y) < DAILY_SPACING) continue;
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
        const letter = this.#drawFiery(player);
        this.log.push(
          letter
            ? `${player.name} ate a chilli ${FRUIT_EMOJI.chilli}: a fiery "${letter.toUpperCase()}"`
            : `${player.name} ate a chilli ${FRUIT_EMOJI.chilli}, but there was nothing hot left to draw`,
        );
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
        this.bag.put(...player.rack);
        player.rack = Array.from({ length: n }, () => this.bag.draw()).filter(Boolean);
        this.log.push(`${player.name} ate a banana ${FRUIT_EMOJI.banana}: a fresh rack of ${player.rack.length}`);
      } else if (type === 'kiwi') {
        // Both wildcards live in the bag like any other tile.
        const blank = player.rack.length < RACK_MAX ? this.bag.take(BLANK) : null;
        if (blank) player.rack.push(blank);
        this.log.push(
          blank
            ? `${player.name} ate a kiwi ${FRUIT_EMOJI.kiwi}: a wildcard`
            : `${player.name} ate a kiwi ${FRUIT_EMOJI.kiwi}, but both wildcards are already in play`,
        );
      }
    }
    return collected;
  }

  /**
   * A chilli's letter comes out of the bag like every other tile: the
   * hottest of J/Q/X/Z still in there, or failing that the highest-scoring
   * letter left.
   */
  #drawFiery(player) {
    if (player.rack.length >= RACK_MAX) return null;
    const hot = FIERY_LETTERS.filter((l) => this.bag.has(l));
    const letter = hot.length
      ? this.bag.take(hot[Math.floor(this.bag.rng() * hot.length)])
      : this.bag.takeBest();
    if (letter) player.rack.push(letter);
    return letter;
  }

  /** Hand back the cherry letters a player was offered but never kept. */
  #returnPendingChoice(player) {
    if (!player.pendingChoice) return;
    this.bag.put(...player.pendingChoice);
    delete player.pendingChoice;
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
    this.bag.put(...letters); // returned only after the replacements are drawn
    player.rack = rackCopy;
    this.lastPlayerId = player.id;
    this.#noteActed(player);
    this.#advanceTurn(player.id);
    this.passed.clear();
    this.#cancelDayVoteOnPlay(player);
    this.log.push(`${player.name}: exchanged ${letters.length} letter${letters.length === 1 ? '' : 's'} (+0)`);
    this.#maybeJumpStar();
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
    this.#noteActed(player);
    this.#advanceTurn(player.id);
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
    // Everything the player doesn't keep goes straight back into the bag.
    const keeping = player.rack.length < RACK_MAX;
    this.bag.put(...choice.filter((_, n) => !keeping || n !== i));
    if (!keeping) {
      this.log.push(
        `${player.name}'s rack was full — the cherry's letters went back in the bag ${FRUIT_EMOJI.cherry}`,
      );
      return { letter: null };
    }
    player.rack.push(letter);
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
    return this.#lay({ playerId, tiles, redefinitions, over: false });
  }

  /**
   * Overwrite move: lay a word straight across letters already on the
   * board. Every word it touches must still be real afterwards, and it has
   * to say something new — you can't rewrite a word as itself. The letters
   * you cover are prised off the board and are yours, up to the rack cap.
   *
   * @param {object} m
   * @param {number} m.playerId
   * @param {{x:number, y:number, letter:string, fromBlank?:boolean}[]} m.tiles
   * @param {{x:number, y:number, as:string}[]} [m.redefinitions]
   */
  overwrite({ playerId, tiles, redefinitions = [] }) {
    return this.#lay({ playerId, tiles, redefinitions, over: true });
  }

  #lay({ playerId, tiles, redefinitions = [], over }) {
    this.#maybeRollover();
    const player = this.player(playerId);
    this.#assertCanPlay(player);

    if (!Array.isArray(tiles) || tiles.length === 0) fail('no tiles to place');
    const boardWasEmpty = this.board.isEmpty();
    if (over) {
      // Spelling a word over the board naturally re-states the letters that
      // already fit — COT over CAT keeps the C and the T. Those cost nothing
      // and change nothing, so drop them and work with what really moves.
      tiles = tiles.filter((t) => {
        const sitting = this.board.get(t.x, t.y);
        return !sitting || t.fromBlank || Board.effective(sitting) !== t.letter;
      });
      if (!tiles.length) fail('that would change nothing');
    }

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
    const covered = []; // tiles being written over, to be picked up after
    for (const t of tiles) {
      const sitting = this.board.get(t.x, t.y);
      if (!sitting) continue;
      if (!over) fail(`cell (${t.x},${t.y}) is already occupied`);
      covered.push({ x: t.x, y: t.y, tile: sitting });
    }
    if (over && !covered.length) fail('that writes over nothing — just play the word');
    const dir = tiles.every((t) => t.y === tiles[0].y)
      ? 'h'
      : tiles.every((t) => t.x === tiles[0].x)
        ? 'v'
        : fail('tiles must be placed in a single row or column');

    // Tentatively apply; anything below that fails must revert.
    const before = over
      ? DIR_NAMES.map((d) => this.board.wordThrough(tiles[0].x, tiles[0].y, d)?.word).filter(Boolean)
      : [];
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
      // Writing over letters is connection enough; a placement has to reach
      // something that was already there.
      if (!boardWasEmpty && !covered.length) {
        const connects = formed.some((w) =>
          w.cells.some((c) => !keys.has(Board.key(c.x, c.y))),
        );
        if (!connects) fail('the word must connect to tiles already on the board');
      }

      for (const w of formed) {
        if (!this.dictionary.has(w.word)) fail(`"${w.word}" is not a real word`);
      }
      // An overwrite has to say something new.
      if (over && formed.every((w) => before.includes(w.word))) {
        fail('an overwrite has to make a different word');
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
      let points = formed.reduce((acc, w) => acc + this.#payFor(player, w, changed), 0);
      const repeats = formed.filter((w) => this.#alreadyScored(player, w.word)).map((w) => w.word);
      this.#noteScored(player, formed.map((w) => w.word));
      if (tiles.length >= RACK_TARGET) points += BINGO_BONUS;

      // Letters written over are prised off the board and pocketed, up to
      // the rack cap; the rest fall back into the day's bag.
      // One tile spent per letter covered, so the rack always has room for
      // what comes off the board.
      let taken = 0;
      for (const c of covered) {
        rackCopy.push(c.tile.isBlank ? BLANK : c.tile.letter);
        taken += 1;
      }
      player.rack = rackCopy;
      const main = formed.find((w) => w.dir === dir) ?? formed[0];
      this.lastMove = { playerId, keys: [...changed] };
      const note = repeats.length
        ? ` (${repeats.map((w) => w.toUpperCase()).join(', ')} already scored today)`
        : '';
      const took = taken ? `, took ${taken} letter${taken === 1 ? '' : 's'}` : '';
      const verb = over ? 'wrote over' : 'played';
      const fruits = this.#commit(
        player, points, `${verb} "${main.word.toUpperCase()}"${took}${note}`, [...changed],
      );
      return { points, words: formed.map((w) => w.word), repeats, taken, fruits };
    } catch (err) {
      for (const t of placed) this.board.remove(t.x, t.y);
      for (const c of covered) this.board.set(c.x, c.y, c.tile); // put them back
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

    // Steal leftovers up to the rack cap; the rest fall back into the bag.
    let stolen = 0;
    let discarded = 0;
    for (const t of pool) {
      const letter = t.isBlank ? BLANK : t.letter;
      if (rackCopy.length < RACK_MAX) {
        rackCopy.push(letter);
        stolen += 1;
      } else {
        this.bag.put(letter);
        discarded += 1;
      }
    }
    player.rack = rackCopy;

    const main = this.board.wordThrough(spanCell(0).x, spanCell(0).y, dir);
    const scoredWords = [main];
    let points = this.#payFor(player, main, changed);
    for (const c of main.cells) {
      if (!changed.has(Board.key(c.x, c.y))) continue;
      for (const cd of crossDirs) {
        const w = this.board.wordThrough(c.x, c.y, cd);
        if (w && w.cells.length >= 2) {
          points += this.#payFor(player, w, changed);
          scoredWords.push(w);
        }
      }
    }
    this.#noteScored(player, scoredWords.map((w) => w.word));

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
        (discarded ? `, ${discarded} back in the bag` : ''),
      coveredKeys,
    );
    return { points, stolen, discarded, word: newWord, fruits };
  }

  /**
   * Mutate move: swap one letter of an existing word for a tile from your
   * rack. Every word through the cell must stay real.
   *
   * A mutation is a trade, not a play. It scores nothing and it does not use
   * your turn — what you get is the tile. The letter you prise off the board
   * takes the place of the one you spent, so your rack keeps its size and
   * gains the letter you were after; the move you make with it is still
   * ahead of you.
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

      // A swap is one tile out, one tile in, so the old one always fits.
      const got = old.isBlank ? BLANK : old.letter;
      rackCopy.push(got);
      player.rack = rackCopy;

      // No score, no turn taken, no fruit, no refill: the tile is the whole
      // point. The board still changed, so the last-word highlight follows it.
      this.lastMove = { playerId, keys: [Board.key(x, y)] };
      this.#noteActed(player);
      this.log.push(
        `${player.name}: mutated ${words.map((w) => `"${w.word.toUpperCase()}"`).join(' & ')}` +
          ` and took the ${got === BLANK ? 'wildcard' : got.toUpperCase()} (free swap)`,
      );
      return { points: 0, words: words.map((w) => w.word), got };
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
      case 'overwrite':
        return this.overwrite(move);
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
      case 'mode':
        return this.setMode(move);
      case 'skip':
        return this.skipTurn(move);
      default:
        fail(`unknown move type: ${move?.type}`);
    }
  }

  /**
   * A snapshot has to own its arrays. The client clones a game to dry-run a
   * move for the score preview, and a `scored` list shared with the original
   * let the dry run bank the word on the real game — so the move you then
   * actually played was "already scored today" and paid nothing.
   */
  static #clonePlayer(p) {
    const copy = { ...p, rack: [...p.rack], scored: [...(p.scored ?? [])] };
    if (Array.isArray(p.pendingChoice)) copy.pendingChoice = [...p.pendingChoice];
    return copy;
  }

  /** Plain-data snapshot of the full game state. */
  toJSON() {
    return {
      day: this.day,
      dateKey: this.dateKey,
      lastPlayerId: this.lastPlayerId,
      adminId: this.adminId,
      mode: this.mode,
      turnId: this.turnId,
      turnStartedAt: this.turnStartedAt ?? null,
      starJumped: Boolean(this.starJumped),
      players: this.players.map((p) => Game.#clonePlayer(p)),
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
    game.players = data.players.map((p) => Game.#clonePlayer(p));
    // Games saved before admin rights existed hand them to the first human.
    const firstHuman = game.players.findIndex((p) => !p.isCpu);
    game.adminId = data.adminId ?? (firstHuman === -1 ? null : firstHuman);
    game.mode = data.mode === 'free' ? 'free' : 'turns';
    game.starJumped = Boolean(data.starJumped);
    game.turnId = data.turnId ?? (game.players.length ? 0 : null);
    game.turnStartedAt = data.turnStartedAt ?? game.now();
    for (const p of game.players) {
      p.lastActedAt ??= game.now();
      p.scored ??= [];
    }
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
