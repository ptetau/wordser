// The wordser game: n-player scrabble on a looping 448x448 world.
//
// House rules implemented here:
//   - A torus board with a recurring criss-cross premium pattern (premium.js).
//   - Premiums pay once, ever: the first letter to land on a premium square
//     collects it and the square is plain board from then on. Adding to a
//     word therefore pays face value for the letters already down.
//   - You can only play after a friend has played: nobody makes two moves in
//     a row, not even the only player at the table.
//   - Three moves put letters on the board: place a word on empty cells,
//     or write over letters already down — swapping or stacking. Both reach
//     as far as you like in one turn, so long as every word they touch stays
//     real and each letter after the first lands in a word the reach already
//     holds. A swap pays nothing and hands you every letter you prised off;
//     a stack scores the words it rewrites and posts those letters back into
//     the bag. Letters for points, or points for letters: never both.
//   - Laying out a full rack in one turn doubles the word.
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
  mushroom: '🍄',
};
const FRUIT_TABLE = [
  ['lemon', 0.15], ['cherry', 0.15], ['chilli', 0.14],
  ['grape', 0.14], ['banana', 0.14], ['kiwi', 0.14],
  ['mushroom', 0.14],
];
// The mushroom's reach: a fresh bag's worth of letters spent rewriting the
// words within this many cells of it, and never more words than this.
const SHROOM_RADIUS = 15;
const SHROOM_WORDS = 40;
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
const MAX_GOAL = 999; // words to play to, at the outside
const DAYS_KEPT = 5; // how many days the leader table remembers
const QUIET_RADIUS = 6; // the patch a new day's star needs to itself...
const QUIET_ENOUGH = 0.99; // ...and how empty it has to be
const STAR_SEARCH = 6; // rings of the premium lattice to look through
const FIERY_LETTERS = ['j', 'q', 'x', 'z'];
const GRAPE_POINTS = 10;
// Scoring a word with nothing "changed": no cell of it is fresh, so no
// premium can pay. A stack writes over squares that were mined long ago.
const EMPTY_KEYS = new Set();

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

/** A copy of `list` in random order, so a search doesn't always try 'a'. */
function shuffled(list, rng) {
  const out = [...new Set(list)];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

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
    this.bag = new Bag(rng); // the day's hundred, played from
    // The fruit have a hundred of their own. What a lemon hands you was
    // never going to be drawn by anybody, so a generous run of fruit can't
    // drain the letters the table is playing with — and the day's bag runs
    // dry through play, which is what the day-end rules are about.
    this.fruitBag = new Bag(rng);
    this.lastMove = null; // { playerId, keys } of the most recent board change
    this.startCell = { ...START_CELL };
    this.#seedFruits();
    this.players = [];
    this.adminId = null; // the seat that may remove players and pass this on
    this.mode = 'turns'; // 'turns' = strict rotation, 'free' = free-for-all
    this.turnId = null; // whose turn it is, in 'turns' mode
    this.lastPlayerId = null;
    this.spent = new Set(); // premium cells already collected, for good
    this.goal = null; // words to play to, or null for a game with no end
    this.wordsPlayed = 0; // words laid down since the game began
    this.over = null; // { winners: [names], best } once the goal is reached
    this.days = []; // the last few days' results, newest last
    this.dayOpenedAt = null; // when the current day began, for the camera
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
      played: 0, // days finished, for the average
      total: 0, // points across all of them
      away: false, // "don't wait for me": their turns pass themselves
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

  /**
   * Start the whole game again from nothing: an empty board, a new bag,
   * fresh racks, scores and records wiped, and whoever the admin nominates
   * to lead off. The players keep their seats.
   */
  restart({ playerId, firstId = null }) {
    this.#assertAdmin(playerId);
    const first = firstId == null ? playerId : this.player(firstId).id;
    this.board = new Board();
    this.fruits.clear();
    this.bag.refill();
    this.fruitBag.refill();
    this.spent = new Set();
    this.days = [];
    this.lastMove = null;
    this.lastPlayerId = null;
    this.passed.clear();
    this.dayEndVote = null;
    this.starJumped = false;
    this.day = 1;
    this.wordsPlayed = 0;
    this.over = null; // the goal itself stands: play the same match again
    this.dateKey = this.#dateKey();
    this.startCell = { ...START_CELL };
    for (const p of this.players) {
      p.score = 0;
      p.stars = 0;
      p.played = 0;
      p.total = 0;
      p.scored = [];
      p.rack = [];
      p.away = false; // a fresh game starts with everyone at the table
      delete p.pendingChoice;
      this.#refill(p);
      this.#noteActed(p);
    }
    this.#seedFruits();
    this.mode = this.mode; // unchanged: the table's own rule stands
    this.turnId = this.mode === 'turns' ? first : null;
    this.turnStartedAt = this.now();
    this.dayOpenedAt = this.now();
    this.log = [`a fresh game — ${this.player(first).name} leads off ✦`];
    return { first };
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
    const out = this.#removeSeat(target);
    this.log.push(`${target.name} was removed from the game`);
    return { removed: target.name, ...out };
  }

  /**
   * Close a seat: their letters go back into the bag, everyone below shifts
   * up, and every id the game was holding is remapped. Returns the `map`
   * from old seat to new (null for the one that left) so callers holding
   * ids of their own can follow.
   */
  #removeSeat(target) {
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

    if (this.dayEndVote) {
      if (this.dayEndVote.proposer === gone) {
        this.dayEndVote = null;
        this.log.push('their proposal to end the day went with them — play on');
      } else {
        this.dayEndVote.proposer = remap(this.dayEndVote.proposer);
        this.dayEndVote.agreed = this.dayEndVote.agreed.map(remap).filter((id) => id !== null);
        // Removing a holdout can be the last vote a proposal was waiting on.
        if (this.dayEndVote.agreed.length >= this.players.length) {
          return { map, ...this.#endDayByAgreement() };
        }
      }
    }
    return { map, dayEnded: false };
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
    if (this.over) fail('the game is over — start another to play on');
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

  /**
   * Play to a target: the game ends the moment the Nth word goes down.
   * `words` of null (or 0) means the old thing — a game that runs until
   * everybody wanders off.
   */
  setGoal({ playerId, words }) {
    this.#maybeRollover();
    this.#assertAdmin(playerId);
    const n = words === null || words === undefined || words === 0 ? null : Number(words);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > MAX_GOAL)) {
      fail(`a target is between 1 and ${MAX_GOAL} words`);
    }
    if (n !== null && n <= this.wordsPlayed) {
      fail(`${this.wordsPlayed} words are already down — pick a bigger target`);
    }
    this.goal = n;
    this.log.push(
      n === null
        ? 'the game will run on with no finish line'
        : `playing to ${n} words — ${n - this.wordsPlayed} to go`,
    );
    return { goal: this.goal, wordsPlayed: this.wordsPlayed };
  }

  /** How many words are left, or null when the game has no end in sight. */
  get wordsLeft() {
    return this.goal === null ? null : Math.max(0, this.goal - this.wordsPlayed);
  }

  /**
   * The last word has gone down (or everyone else has gone home): work out
   * who won and shut the game. The board stays exactly as it finished — it
   * is the scoreboard, after all.
   */
  #finish(why) {
    if (this.over) return this.over;
    const best = Math.max(0, ...this.players.map((p) => p.score));
    const winners = this.players.filter((p) => p.score === best).map((p) => p.name);
    this.over = { winners, best, why };
    this.turnId = null;
    this.log.push(
      winners.length
        ? `${why} — ${winners.join(' & ')} ${winners.length > 1 ? 'share it' : 'wins'} on ${best} 🏆`
        : `${why} — nobody scored`,
    );
    return this.over;
  }

  /**
   * Give up and leave the table. Your letters go back into the day's bag and
   * the seat closes behind you, exactly as if the admin had removed you —
   * this is the same door, opened from the inside. If it leaves one player
   * standing, they have won.
   */
  forfeit({ playerId }) {
    this.#maybeRollover();
    const player = this.player(playerId);
    if (this.over) fail('the game is already over');
    const name = player.name;
    const wasAdmin = this.isAdmin(player.id);
    const out = this.#removeSeat(player);
    this.log.push(`${name} forfeited 🏳️`);
    if (wasAdmin) {
      // Somebody has to run the table: the first human still at it.
      const heir = this.players.find((p) => !p.isCpu);
      this.adminId = heir ? heir.id : null;
      if (heir) this.log.push(`${heir.name} runs the game now 👑`);
    }
    if (this.players.length === 1) {
      this.#finish(`${name} forfeited`);
    } else if (!this.players.length) {
      this.over = { winners: [], best: 0, why: 'everyone forfeited' };
    }
    return { forfeited: name, ...out };
  }

  /** Hand the turn to the next seat along (a no-op in free-for-all). */
  #advanceTurn(fromId) {
    if (this.mode !== 'turns' || !this.players.length) return;
    const from = fromId ?? this.turnId ?? 0;
    this.turnId = (from + 1) % this.players.length;
    this.turnStartedAt = this.now();
  }

  /**
   * A seat holding no letters has nothing it can do. If the bag can deal to
   * them, it does; if it can't, they pass and the turn carries on round
   * rather than everyone waiting for a move that cannot come.
   */
  /**
   * Settle the turn after something has changed it: hand it past anybody
   * who has nothing to play, then past anybody who has said not to wait for
   * them. Both loops are bounded by the size of the table — if everyone is
   * out, the turn stays where it is rather than spinning.
   */
  #resolveTurn() {
    // A finished game has no turn to settle, and free-for-all never had one.
    if (this.over || this.turnId === null) return;
    this.#passTheTileless();
    this.#skipTheAway();
  }

  /**
   * Pass the turn along past players who have said they are busy. Somebody
   * has to be able to move: if every remaining seat is away, the turn is
   * left where it stopped and the game simply waits.
   */
  #skipTheAway() {
    if (this.mode !== 'turns' || this.players.length < 2 || this.over) return;
    if (this.players.every((p) => p.away || p.isCpu) && this.players.some((p) => p.away)) return;
    for (let guard = 0; guard < this.players.length; guard++) {
      const p = this.player(this.turnId);
      if (!p?.away) return;
      this.log.push(`${p.name} is away — their turn passed ⏭`);
      this.passed.add(p.id);
      this.lastPlayerId = p.id;
      this.#noteActed(p, { voluntary: false });
      this.turnId = (this.turnId + 1) % this.players.length;
      this.turnStartedAt = this.now();
      if (this.bag.pool.length === 0 && this.passed.size >= this.players.length) {
        this.log.push('everyone passed on an empty bag — the day ends early');
        this.startNewDay();
        return;
      }
    }
  }

  #passTheTileless() {
    if (this.mode !== 'turns' || this.players.length < 2) return;
    for (let guard = 0; guard < this.players.length; guard++) {
      const p = this.player(this.turnId);
      if (!p) return;
      if (!p.rack.length) this.#refill(p); // deal them in if the bag can
      if (p.rack.length) return;
      this.passed.add(p.id);
      this.lastPlayerId = p.id;
      this.#noteActed(p, { voluntary: false });
      this.log.push(`${p.name} has no letters left — passed`);
      this.turnId = (this.turnId + 1) % this.players.length;
      this.turnStartedAt = this.now();
      if (this.passed.size >= this.players.length) {
        this.log.push('nobody has a letter to play — the day ends early');
        this.startNewDay();
        return;
      }
    }
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
  /**
   * Mark a seat as having done something. A move of your own also says you
   * are back — nobody who just played a word needs to be skipped — while a
   * skip or an automatic pass says nothing about where you are.
   */
  #noteActed(player, { voluntary = true } = {}) {
    player.lastActedAt = this.now();
    if (voluntary && player.away) {
      player.away = false;
      this.log.push(`${player.name} is back at the table 👋`);
    }
  }

  /**
   * "Don't wait for me." A player who knows they are busy can have their
   * turns passed the moment they arrive, so a game of four doesn't stall on
   * one of them all afternoon. It is theirs to set and theirs to clear, and
   * playing anything at all clears it.
   */
  setAway({ playerId, away }) {
    this.#maybeRollover();
    const player = this.player(playerId);
    if (player.isCpu) fail('a robot is never away');
    const next = Boolean(away);
    if (player.away === next) return { away: next };
    player.away = next;
    this.log.push(
      next
        ? `${player.name} is busy — their turns will pass themselves ⏭`
        : `${player.name} is back at the table 👋`,
    );
    if (next) this.#resolveTurn();
    return { away: next };
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
    this.#noteActed(target, { voluntary: false }); // a skip restarts the clock
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
    // The day goes into the record: the last five are the leader table, and
    // every day ever played feeds each player's average.
    this.days.push({
      day: this.day,
      scores: this.players.map((p) => ({
        name: p.name, score: p.score, won: winners.includes(p),
      })),
    });
    if (this.days.length > DAYS_KEPT) this.days = this.days.slice(-DAYS_KEPT);
    for (const p of this.players) {
      p.played = (p.played ?? 0) + 1;
      p.total = (p.total ?? 0) + p.score;
    }
    if (winners.length) {
      this.log.push(`day ${this.day} won by ${winners.map((w) => w.name).join(', ')} (${best} pts) ★`);
    } else {
      this.log.push(`day ${this.day} ends with no winner`);
    }
    // A brand-new 100-tile set for the new day, dealt before the fresh
    // racks. Yesterday's unplayed letters go with yesterday's bag — only
    // what reached the board outlives the day.
    this.bag.refill();
    this.fruitBag.refill();
    this.starJumped = false;
    for (const p of this.players) {
      p.score = 0;
      p.scored = []; // yesterday's words pay again today
      // A new day deals everyone a completely fresh rack.
      p.rack = [];
      delete p.pendingChoice;
      this.#refill(p);
    }
    this.startCell = this.#nextStartCell();
    // Yesterday's leftovers are scattered wherever yesterday's play went;
    // lay out a fresh crop within reach of today's.
    this.fruits.clear();
    this.#seedFruits();
    this.log.push(`the start star ★ moved and everyone drew a fresh rack`);
    this.log.push(`${this.fruits.size} fresh fruits are within reach 🍒`);
    this.day += 1;
    this.dayOpenedAt = this.now(); // clients pan to the new star once
    // lastPlayerId carries over: closing one day and opening the next is
    // still two turns in a row.
    this.passed.clear();
    this.dayEndVote = null;
    this.dateKey = this.#dateKey();
    return winners;
  }

  /**
   * Where tomorrow starts: the nearest double-word star to today's play
   * whose neighbourhood is all but empty. A new day should open on clean
   * ground within walking distance of the words already down — not on top of
   * them, and not in a wilderness nobody will find.
   */
  #nextStartCell() {
    const cells = [...this.board.cells.keys()].map((k) => k.split(',').map(Number));
    const from = cells.length
      ? cells[Math.floor(this.bag.rng() * cells.length)]
      : [this.startCell.x, this.startCell.y];
    const quiet = (sx, sy) => {
      let taken = 0;
      let total = 0;
      for (let dx = -QUIET_RADIUS; dx <= QUIET_RADIUS; dx++) {
        for (let dy = -QUIET_RADIUS; dy <= QUIET_RADIUS; dy++) {
          total += 1;
          if (this.board.get(sx + dx, sy + dy)) taken += 1;
        }
      }
      return 1 - taken / total;
    };
    // Stars sit on the premium lattice, so walk it outward from the play.
    const cx = Math.round(from[0] / PERIOD) * PERIOD;
    const cy = Math.round(from[1] / PERIOD) * PERIOD;
    let fallback = null;
    for (let r = 1; r <= STAR_SEARCH; r++) {
      const ring = [];
      for (let i = -r; i <= r; i++) {
        for (let j = -r; j <= r; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          ring.push([wrapCoord(cx + i * PERIOD), wrapCoord(cy + j * PERIOD)]);
        }
      }
      // Shuffle the ring so the same corner isn't always chosen.
      for (let i = ring.length - 1; i > 0; i--) {
        const j = Math.floor(this.bag.rng() * (i + 1));
        [ring[i], ring[j]] = [ring[j], ring[i]];
      }
      for (const [sx, sy] of ring) {
        if (sx === this.startCell.x && sy === this.startCell.y) continue;
        const clear = quiet(sx, sy);
        if (clear >= QUIET_ENOUGH) return { x: sx, y: sy };
        if (!fallback || clear > fallback.clear) fallback = { x: sx, y: sy, clear };
      }
    }
    return fallback ? { x: fallback.x, y: fallback.y } : { ...this.startCell };
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
    const before = this.turnId;
    this.#resolveTurn();
    if (this.turnId !== before) changed = true;
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
      const key = Board.key(c.x, c.y);
      if (changed.has(key) && !this.spent.has(key)) {
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

  /**
   * A premium square is a seam of ore, not a renewable crop: the first move
   * to write a letter onto it takes the bonus and the square is plain board
   * from then on. Everything after that — extending the word, writing over
   * it, stealing it — is paid at face value, which is what stops a corner
   * triple-word being re-mined every day by rewriting the same cell.
   */
  #spendPremiums(changed) {
    for (const key of changed) {
      const [x, y] = key.split(',').map(Number);
      if (premiumAt(x, y)) this.spent.add(key);
    }
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
    this.#resolveTurn(); // don't hand it to someone with nothing, or nobody
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
      // No announcement: which fruit is which is for the board to say and
      // for a player to find out by eating it, not for the log to give away.
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
          const l = this.fruitBag.draw();
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
        const offered = Array.from(
          { length: CHERRY_CHOICES },
          () => this.fruitBag.draw(),
        ).filter(Boolean);
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
        // The old rack came out of the day's bag, so that is where it goes
        // back; the fresh one is the fruit's to give.
        const n = player.rack.length;
        this.bag.put(...player.rack);
        player.rack = Array.from({ length: n }, () => this.fruitBag.draw()).filter(Boolean);
        this.log.push(`${player.name} ate a banana ${FRUIT_EMOJI.banana}: a fresh rack of ${player.rack.length}`);
      } else if (type === 'mushroom') {
        const [x, y] = k.split(',').map(Number);
        const r = this.#mushroom(player, x, y);
        this.log.push(
          r.rewritten
            ? `${player.name} ate a mushroom ${FRUIT_EMOJI.mushroom}: the board rewrote itself — ` +
              `${r.rewritten} word${r.rewritten === 1 ? '' : 's'} changed, and ` +
              `${r.returned} letter${r.returned === 1 ? '' : 's'} went into the bag for everyone`
            : `${player.name} ate a mushroom ${FRUIT_EMOJI.mushroom}, but nothing round here would budge`,
        );
      } else if (type === 'kiwi') {
        // Both wildcards live in the bag like any other tile.
        const blank = player.rack.length < RACK_MAX ? this.fruitBag.take(BLANK) : null;
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
   * The mushroom: hand the board a whole fresh bag of letters and let it
   * rewrite as many of the words around it as those letters will stretch
   * to. Every word the changes touch must still be real — the board is left
   * legal, just not the way anyone left it — and every letter prised out
   * drops into the day's bag, where it belongs to everybody. Eating one is
   * not a private windfall: it churns the board and restocks the table.
   *
   * It spends the fruit bag, like every other fruit, and hands what it
   * displaces to the players' bag — so a mushroom moves letters from the
   * fruit's hundred into the table's, which is as generous as it sounds.
   *
   * Bounded on purpose: the words within SHROOM_RADIUS, at most
   * SHROOM_WORDS of them, one substitution attempted per word. A mushroom
   * is a surprise, not a solver competition.
   */
  #mushroom(player, ox, oy) {
    const shroomBag = this.fruitBag;
    let rewritten = 0;
    let returned = 0;

    // Every word with a cell inside the radius, nearest first.
    const found = new Map();
    for (const key of this.board.cells.keys()) {
      const [x, y] = key.split(',').map(Number);
      const dx = Math.abs(wrapCoord(x) - wrapCoord(ox));
      const dy = Math.abs(wrapCoord(y) - wrapCoord(oy));
      const d = Math.max(Math.min(dx, WORLD - dx), Math.min(dy, WORLD - dy));
      if (d > SHROOM_RADIUS) continue;
      for (const dir of DIR_NAMES) {
        const w = this.board.wordThrough(x, y, dir);
        if (!w || w.cells.length < 2) continue;
        const id = `${dir}:${w.cells[0].x},${w.cells[0].y}`;
        if (!found.has(id) || found.get(id).d > d) found.set(id, { w, dir, d });
      }
    }
    const words = [...found.values()].sort((a, b) => a.d - b.d).slice(0, SHROOM_WORDS);

    for (const { w, dir } of words) {
      if (!shroomBag.pool.length) break;
      // Re-read the word: an earlier rewrite may have changed it under us.
      const head = w.cells[0];
      const live = this.board.wordThrough(head.x, head.y, dir);
      if (!live || live.cells.length < 2) continue;
      const swapped = this.#rewriteWord(live, shroomBag);
      if (!swapped) continue;
      rewritten += 1;
      this.bag.put(swapped);
      returned += 1;
    }
    return { rewritten, returned };
  }

  /**
   * Turn one word into a different real word by replacing a single letter
   * from `supply`, leaving every crossing word real. Returns the letter it
   * prised out, or null if the word wouldn't budge.
   */
  #rewriteWord(w, supply) {
    const letters = [...w.word];
    for (let i = 0; i < w.cells.length; i++) {
      const cell = w.cells[i];
      if (cell.tile.isBlank) continue; // leave wildcards where they are
      for (const candidate of shuffled(supply.pool, supply.rng)) {
        if (candidate === BLANK || candidate === letters[i]) continue;
        const attempt = [...letters];
        attempt[i] = candidate;
        if (!this.dictionary.has(attempt.join(''))) continue;
        const old = cell.tile;
        this.board.set(cell.x, cell.y, { letter: candidate });
        const crossOk = DIR_NAMES.every((d) => {
          const cw = this.board.wordThrough(cell.x, cell.y, d);
          return !cw || cw.cells.length < 2 || this.dictionary.has(cw.word);
        });
        if (!crossOk) {
          this.board.set(cell.x, cell.y, old);
          continue;
        }
        supply.take(candidate);
        return old.letter;
      }
    }
    return null;
  }

  /**
   * A chilli's letter comes out of the bag like every other tile: the
   * hottest of J/Q/X/Z still in there, or failing that the highest-scoring
   * letter left.
   */
  #drawFiery(player) {
    if (player.rack.length >= RACK_MAX) return null;
    const hot = FIERY_LETTERS.filter((l) => this.fruitBag.has(l));
    const letter = hot.length
      ? this.fruitBag.take(hot[Math.floor(this.bag.rng() * hot.length)])
      : this.fruitBag.takeBest();
    if (letter) player.rack.push(letter);
    return letter;
  }

  /** Hand back the cherry letters a player was offered but never kept. */
  #returnPendingChoice(player) {
    if (!player.pendingChoice) return;
    this.fruitBag.put(...player.pendingChoice);
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
    const day = this.day;
    this.#resolveTurn();
    return { passed: true, dayEnded: this.day !== day, points: 0 };
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
    this.fruitBag.put(...choice.filter((_, n) => !keeping || n !== i));
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
    return this.#lay({ playerId, tiles, redefinitions });
  }

  #lay({ playerId, tiles, redefinitions = [] }) {
    this.#maybeRollover();
    const player = this.player(playerId);
    this.#assertCanPlay(player);

    if (!Array.isArray(tiles) || tiles.length === 0) fail('no tiles to place');
    const boardWasEmpty = this.board.isEmpty();
    const held = player.rack.length;

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
      if (this.board.get(t.x, t.y)) {
        fail(`cell (${t.x},${t.y}) is taken — swap that letter instead`);
      }
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
      let points = formed.reduce((acc, w) => acc + this.#payFor(player, w, changed), 0);
      const repeats = formed.filter((w) => this.#alreadyScored(player, w.word)).map((w) => w.word);
      this.#noteScored(player, formed.map((w) => w.word));
      this.#spendPremiums(changed);

      // Laying out a full rack in one go — every last tile of it — doubles
      // the word. Not the same thing as the bingo, which counts tiles: this
      // one asks you to arrive with a full tray and leave with nothing. It
      // doubles the word the way a premium square would, so the flat bingo
      // is added afterwards rather than doubled along with it.
      const emptied = held >= RACK_TARGET && rackCopy.length === 0;
      if (emptied) points *= 2;
      if (tiles.length >= RACK_TARGET) points += BINGO_BONUS;

      player.rack = rackCopy;
      const main = formed.find((w) => w.dir === dir) ?? formed[0];
      this.lastMove = { playerId, keys: [...changed] };
      const note = repeats.length
        ? ` (${repeats.map((w) => w.toUpperCase()).join(', ')} already scored today)`
        : '';
      const cleared = emptied ? ' — the whole tray, doubled! 🎉' : '';
      const fruits = this.#commit(
        player, points, `played "${main.word.toUpperCase()}"${note}${cleared}`, [...changed],
      );
      // One word laid down, however many it happens to cross.
      this.wordsPlayed += 1;
      const finished = this.goal !== null && this.wordsPlayed >= this.goal
        ? this.#finish(`word ${this.goal} of ${this.goal}`)
        : null;
      return {
        points, words: formed.map((w) => w.word), repeats, emptied, fruits,
        wordsPlayed: this.wordsPlayed, wordsLeft: this.wordsLeft, finished,
      };
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
   * Swap move: trade letters of your own for letters already on the board —
   * as many as you like, in one reach. Every word through every cell you
   * touch must still be real afterwards, and after the first letter each
   * one has to land in a word the reach already holds.
   *
   * A swap is a raid on the board, not a play: it scores nothing at all.
   * What it gets you is letters — every tile you prise off goes into your
   * rack in place of the one you spent — and it costs you your turn.
   *
   * @param {object} m
   * @param {number} m.playerId
   * @param {{x:number, y:number, letter:string, fromBlank?:boolean}[]} m.swaps
   */
  swap({ playerId, swaps }) {
    return this.#overwrite({ playerId, plays: swaps, keep: true });
  }

  /**
   * Stack move: the same reach across the board as a swap, and the same
   * rule that every word it touches must stay real — but the other way
   * round on both counts. The words you have rewritten pay you (once a day
   * each, as ever, and never a premium: those squares were spent by the
   * letters that first landed on them), and the letters you wrote over are
   * gone, back into the table's bag for somebody to draw.
   *
   * @param {object} m
   * @param {number} m.playerId
   * @param {{x:number, y:number, letter:string, fromBlank?:boolean}[]} m.stacks
   */
  stack({ playerId, stacks }) {
    return this.#overwrite({ playerId, plays: stacks, keep: false });
  }

  /**
   * Writing over letters already down, which the two moves above differ
   * only in the settling of: a swap keeps the letters and scores nothing, a
   * stack scores the words and loses the letters.
   */
  #overwrite({ playerId, plays, keep }) {
    const verb = keep ? 'swap' : 'stack';
    const past = keep ? 'swapped' : 'stacked';
    const doing = keep ? 'swapping' : 'stacking';
    this.#maybeRollover();
    const player = this.player(playerId);
    this.#assertCanPlay(player);
    if (!Array.isArray(plays) || plays.length === 0) fail(`pick at least one letter to ${verb}`);

    const keys = new Set(plays.map((sw) => Board.key(sw.x, sw.y)));
    if (keys.size !== plays.length) fail(`you can only ${verb} a cell once`);

    const rackCopy = [...player.rack];
    const olds = [];
    for (const sw of plays) {
      const old = this.board.get(sw.x, sw.y) ?? fail(`no tile at (${sw.x},${sw.y}) to ${verb}`);
      if (!isLetter(sw.letter)) fail(`invalid letter: ${sw.letter}`);
      if (Board.effective(old) === sw.letter && !sw.fromBlank) {
        fail(`${doing} "${sw.letter.toUpperCase()}" for itself changes nothing`);
      }
      const need = sw.fromBlank ? BLANK : sw.letter;
      if (!removeOne(rackCopy, need)) {
        fail(sw.fromBlank ? 'no blank tile in your rack' : `no "${sw.letter}" in your rack`);
      }
      olds.push({ x: sw.x, y: sw.y, tile: old });
    }

    for (const sw of plays) {
      this.board.set(sw.x, sw.y, sw.fromBlank ? { isBlank: true, as: sw.letter } : { letter: sw.letter });
    }
    try {
      const words = [];
      const seen = new Set();
      const wordsAt = plays.map(() => []);
      plays.forEach((sw, i) => {
        let part = false;
        for (const d of DIR_NAMES) {
          const w = this.board.wordThrough(sw.x, sw.y, d);
          if (!w || w.cells.length < 2) continue;
          part = true;
          const id = `${d}:${w.cells[0].x},${w.cells[0].y}`;
          wordsAt[i].push(id);
          if (seen.has(id)) continue;
          seen.add(id);
          words.push(w);
        }
        if (!part) fail(`every ${past} tile must be part of a word`);
      });
      Game.#assertOneReach(wordsAt, verb);
      for (const w of words) {
        if (!this.dictionary.has(w.word)) fail(`"${w.word}" is not a real word`);
      }

      const n = plays.length;
      const list = words.map((w) => `"${w.word.toUpperCase()}"`).join(' & ');
      this.lastMove = { playerId, keys: [...keys] };
      const covered = [...keys];

      if (keep) {
        // One tile out, one tile in, every time: the rack always has room.
        for (const o of olds) rackCopy.push(o.tile.isBlank ? BLANK : o.tile.letter);
        player.rack = rackCopy;
        const took = olds.map((o) => (o.tile.isBlank ? BLANK : o.tile.letter));
        const fruits = this.#commit(
          player, 0,
          `swapped ${n} letter${n === 1 ? '' : 's'} into ${list} — letters, not points`,
          covered,
        );
        return { points: 0, words: words.map((w) => w.word), took, fruits };
      }

      // A stack is paid for in letters: what you wrote over goes back into
      // the bag everyone draws from. No premiums — an occupied square has
      // long since been mined by whoever first landed on it — so the empty
      // `changed` set here is the whole of that rule.
      const points = words.reduce((acc, w) => acc + this.#payFor(player, w, EMPTY_KEYS), 0);
      const repeats = words.filter((w) => this.#alreadyScored(player, w.word)).map((w) => w.word);
      this.#noteScored(player, words.map((w) => w.word));
      player.rack = rackCopy;
      const gave = olds.map((o) => (o.tile.isBlank ? BLANK : o.tile.letter));
      this.bag.put(...gave);
      const note = repeats.length
        ? ` (${repeats.map((w) => w.toUpperCase()).join(', ')} already scored today)`
        : '';
      const fruits = this.#commit(
        player, points,
        `stacked ${n} letter${n === 1 ? '' : 's'} into ${list}${note}`,
        covered,
      );
      // Rewriting the board is playing a word: it counts towards the target,
      // so a finish line can't be stalled at by restacking for ever.
      this.wordsPlayed += 1;
      const finished = this.goal !== null && this.wordsPlayed >= this.goal
        ? this.#finish(`word ${this.goal} of ${this.goal}`)
        : null;
      return {
        points, words: words.map((w) => w.word), repeats, gave, fruits,
        wordsPlayed: this.wordsPlayed, wordsLeft: this.wordsLeft, finished,
      };
    } catch (err) {
      for (const o of olds) this.board.set(o.x, o.y, o.tile);
      throw err;
    }
  }

  /**
   * One reach, not several errands: after the first letter, every letter
   * has to land in a word that already carries one of this turn's. Two
   * letters are linked when the same word runs through both, so the move is
   * legal exactly when that graph is connected — which is another way of
   * saying you could have laid them down one at a time, each one landing in
   * a word the ones before it had already touched.
   *
   * @param {string[][]} wordsAt the words each swapped cell belongs to
   */
  static #assertOneReach(wordsAt, verb) {
    if (wordsAt.length < 2) return;
    const parent = wordsAt.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const owner = new Map();
    wordsAt.forEach((ids, i) => {
      for (const id of ids) {
        if (!owner.has(id)) {
          owner.set(id, i);
          continue;
        }
        const a = find(owner.get(id));
        const b = find(i);
        if (a !== b) parent[a] = b;
      }
    });
    const root = find(0);
    if (wordsAt.some((_, i) => find(i) !== root)) {
      fail(`every letter after the first must ${verb} into a word the others already touch`);
    }
  }

  /**
   * Draw a line under the day: yesterday's scores go into the record, the
   * winner takes a ★, everyone gets a fresh rack and the start star moves.
   * The board stays. A finished game reopens on the new day — which is the
   * gentler of the admin's two ways to play on, the other being a restart
   * that wipes the board.
   */
  newDay({ playerId }) {
    this.#maybeRollover();
    this.#assertAdmin(playerId);
    const winners = this.startNewDay().map((w) => w.name);
    if (this.over) {
      this.over = null;
      this.wordsPlayed = 0; // the same finish line, run again
      this.turnId = null;
      this.#advanceTurn(this.lastPlayerId ?? this.players.length - 1);
      this.log.push('a new day — the game is on again ✦');
      this.#resolveTurn();
    }
    return { winners, day: this.day, startCell: { ...this.startCell } };
  }

  /** Dispatch a move described as plain data (used by the network server). */
  apply(move) {
    switch (move?.type) {
      case 'place':
        return this.place(move);
      case 'swap':
        return this.swap(move);
      case 'stack':
        return this.stack(move);
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
      case 'restart':
        return this.restart(move);
      case 'goal':
        return this.setGoal(move);
      case 'forfeit':
        return this.forfeit(move);
      case 'away':
        return this.setAway(move);
      case 'newDay':
        return this.newDay(move);
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
      spent: [...this.spent],
      goal: this.goal,
      wordsPlayed: this.wordsPlayed,
      over: this.over ? { ...this.over, winners: [...this.over.winners] } : null,
      days: this.days.map((d) => ({ day: d.day, scores: d.scores.map((x) => ({ ...x })) })),
      dayOpenedAt: this.dayOpenedAt ?? null,
      dayEndVote: this.dayEndVote ? { ...this.dayEndVote, agreed: [...this.dayEndVote.agreed] } : null,
      bag: [...this.bag.pool].sort().join(''),
      fruitBag: [...this.fruitBag.pool].sort().join(''),
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
      p.played ??= 0;
      p.total ??= 0;
      p.away ??= false;
    }
    for (const { x, y, ...tile } of data.cells) game.board.set(x, y, tile);
    game.fruits.clear(); // replace the constructor's fresh scatter with the snapshot's
    for (const { x, y, type } of data.fruits ?? []) game.fruits.set(Board.key(x, y), type);
    game.lastMove = data.lastMove ?? null;
    game.startCell = data.startCell ? { ...data.startCell } : { ...START_CELL };
    if (typeof data.bag === 'string') game.bag.pool = [...data.bag];
    // Games saved before the fruit had a bag of their own start with a full
    // one: the letters they had already handed out came from the day's bag,
    // which is where the snapshot still has them.
    if (typeof data.fruitBag === 'string') game.fruitBag.pool = [...data.fruitBag];
    game.passed = new Set(data.passed ?? []);
    game.spent = new Set(data.spent ?? []);
    game.goal = data.goal ?? null;
    game.wordsPlayed = data.wordsPlayed ?? 0;
    game.over = data.over ? { ...data.over, winners: [...(data.over.winners ?? [])] } : null;
    game.days = (data.days ?? []).map((d) => ({ day: d.day, scores: (d.scores ?? []).map((x) => ({ ...x })) }));
    game.dayOpenedAt = data.dayOpenedAt ?? null;
    game.dayEndVote = data.dayEndVote ? { ...data.dayEndVote, agreed: [...data.dayEndVote.agreed] } : null;
    game.log = [...(data.log ?? [])];
    return game;
  }
}
