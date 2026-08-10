// Online play: one serverless endpoint, the same rules engine as the client.
//
// The server is authoritative: clients describe moves as plain data, the
// engine validates and applies them here, and everyone polls the resulting
// state. Storage is a single JSON document per game in Redis (Vercel's
// "Upstash for Redis" marketplace integration; KV_REST_API_* /
// UPSTASH_REDIS_REST_* env vars), written with a compare-and-set on a
// sequence number so concurrent moves can't trample each other.

import { Game, GameError } from '../public/engine/game.js';
import { loadBundledDictionary } from '../public/engine/dictionary.js';
import { buildWordList, takeCpuTurn } from '../public/cpu.js';
import { RespClient } from './resp.js';

const KEY = (id) => `wordser:game:${id}`;
const MAX_PLAYERS = 16;
/** Moves that don't consume a turn, so no CPU seat should answer them. */
const NON_TURN_MOVES = ['choose', 'proposeEnd', 'voteEnd', 'kick', 'admin'];

let dictionaryPromise;
const dictionary = () => (dictionaryPromise ??= loadBundledDictionary());
let cpuWordsPromise;
const cpuWords = () => (cpuWordsPromise ??= dictionary().then(buildWordList));

/**
 * Let every eligible CPU seat take one turn (same rules as the client).
 * takeCpuTurn itself falls back to exchanging and then passing, so an
 * eligible CPU always resolves its turn one way or another.
 */
function runCpuTurns(game, wordList) {
  for (const p of game.players) {
    if (!p.isCpu) continue;
    if (game.lastPlayerId === p.id) continue;
    takeCpuTurn(game, p.id, wordList);
  }
}

// ---------------------------------------------------------------- storage

/**
 * Redis-backed store; null when no credentials are configured. Speaks the
 * Upstash REST API when those vars exist, otherwise plain RESP over TCP/TLS
 * for a REDIS_URL connection string.
 */
export function envStore(env = process.env) {
  const restUrl = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const restToken = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  let call;
  let source;
  if (restUrl && restToken) {
    source = 'rest';
    call = async (cmd) => {
      const r = await fetch(restUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${restToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(cmd),
      });
      const j = await r.json();
      if (j.error) throw new Error(`redis: ${j.error}`);
      return j.result;
    };
  } else if (env.REDIS_URL) {
    source = 'tcp';
    const client = new RespClient(env.REDIS_URL);
    call = (cmd) => client.cmd(cmd);
  } else {
    return null;
  }
  const CAS = `local cur = redis.call('GET', KEYS[1])
if cur then
  local c = cjson.decode(cur)
  if tostring(c.seq) ~= ARGV[2] then return 'CONFLICT' end
elseif ARGV[2] ~= '0' then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[1])
return 'OK'`;
  return {
    async get(key) {
      const v = await call(['GET', key]);
      return v ? JSON.parse(v) : null;
    },
    /** Read-only store health probe (no secrets). */
    async diag(key) {
      return {
        envSource: source,
        exists: await call(['EXISTS', key]),
        ttl: await call(['TTL', key]),
        dbsize: await call(['DBSIZE']),
      };
    },
    /** Write `value` only if the stored seq still equals expectedSeq (0 = absent). Games never expire. */
    async put(key, value, expectedSeq) {
      const res = await call(['EVAL', CAS, '1', key, JSON.stringify(value), String(expectedSeq)]);
      return res === 'OK';
    },
  };
}

/** In-memory store with the same contract, for tests and local dev. */
export function memoryStore() {
  const m = new Map();
  return {
    async get(key) {
      return m.has(key) ? JSON.parse(m.get(key)) : null;
    },
    async put(key, value, expectedSeq) {
      const cur = m.has(key) ? JSON.parse(m.get(key)) : null;
      if (cur ? cur.seq !== expectedSeq : expectedSeq !== 0) return false;
      m.set(key, JSON.stringify(value));
      return true;
    },
  };
}

// ------------------------------------------------------------------ logic

const newGameId = () =>
  Array.from({ length: 8 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[(Math.random() * 31) | 0]).join('');

const cleanName = (name) => {
  const s = String(name ?? '').trim().slice(0, 20);
  if (!s) throw new GameError('a player name is required');
  return s;
};

/** The state one player is allowed to see. */
function view(record, playerId) {
  const game = structuredClone(record.game);
  for (const p of game.players) {
    delete p.token;
    if (p.id !== playerId) {
      p.rack = p.rack.map(() => '?');
      delete p.pendingChoice;
    }
  }
  return { seq: record.seq, id: record.id, you: playerId, game };
}

/**
 * The token is the credential; the id a client sends is only a hint, since
 * removing a player shifts every seat below them along.
 */
function authPlayer(record, token) {
  const p = token ? record.game.players.find((q) => q.token === token) : null;
  if (!p) throw Object.assign(new Error('bad player credentials'), { status: 403 });
  return p;
}

/**
 * Copy player tokens from the stored record onto a fresh snapshot. `map`
 * (returned by a removal) takes an old seat index to its new one; without
 * one the seats line up exactly.
 */
function carryTokens(data, record, map) {
  record.game.players.forEach((p, oldId) => {
    const newId = map ? map[oldId] : oldId;
    if (newId != null && data.players[newId]) data.players[newId].token = p.token;
  });
  return data;
}

async function loadGame(record) {
  return Game.fromJSON(record.game, { dictionary: await dictionary() });
}

/**
 * Handle one API action against a store. Returns { status, data }.
 * Actions: create {name} · join {id, name} · state {id, playerId, token, since}
 *        · move {id, playerId, token, move} · addcpu {id, playerId, token}
 */
export async function handleAction(store, body) {
  try {
    const action = body?.action;
    if (action === 'create') {
      const name = cleanName(body.name);
      const game = new Game({ dictionary: await dictionary() });
      const player = game.addPlayer(name);
      const token = crypto.randomUUID();
      const data = game.toJSON();
      data.players[player.id].token = token;
      const record = { id: newGameId(), seq: 1, game: data };
      if (!(await store.put(KEY(record.id), record, 0))) {
        return { status: 409, data: { error: 'try again' } };
      }
      return { status: 200, data: { ...view(record, player.id), token } };
    }

    if (action === 'diag') {
      const env = process.env;
      const base = {
        build: 'diag2',
        hasKvUrl: Boolean(env.KV_REST_API_URL),
        hasKvToken: Boolean(env.KV_REST_API_TOKEN),
        hasUpstashUrl: Boolean(env.UPSTASH_REDIS_REST_URL),
        hasUpstashToken: Boolean(env.UPSTASH_REDIS_REST_TOKEN),
        redisHost: (env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL ?? '').replace(/^https?:\/\//, '').slice(0, 12),
        storeKind: store?.diag ? 'redis' : 'memory',
        envNames: Object.keys(env).filter((k) => /redis|kv|upstash|storage/i.test(k)).sort(),
      };
      try {
        const probe = store.diag ? await store.diag(KEY(body?.id ?? '')) : {};
        return { status: 200, data: { ...base, ...probe } };
      } catch (err) {
        return { status: 200, data: { ...base, diagError: String(err.message).slice(0, 200) } };
      }
    }

    const record = await store.get(KEY(body?.id));
    if (!record) return { status: 404, data: { error: 'no such game' } };

    if (action === 'join') {
      if (record.game.players.length >= MAX_PLAYERS) {
        return { status: 400, data: { error: 'this game is full' } };
      }
      const name = cleanName(body.name);
      const game = await loadGame(record);
      const player = game.addPlayer(name);
      const token = crypto.randomUUID();
      const data = carryTokens(game.toJSON(), record);
      data.players[player.id].token = token;
      const next = { id: record.id, seq: record.seq + 1, game: data };
      if (!(await store.put(KEY(record.id), next, record.seq))) {
        return { status: 409, data: { error: 'the game changed underneath you — try again' } };
      }
      return { status: 200, data: { ...view(next, player.id), token } };
    }

    const playerId = authPlayer(record, body?.token).id;

    if (action === 'addcpu') {
      if (record.game.players.length >= MAX_PLAYERS) {
        return { status: 400, data: { error: 'this game is full' } };
      }
      const game = await loadGame(record);
      const cpu = game.addCpu();
      game.log.push(`${cpu.name} joined the game`);
      runCpuTurns(game, await cpuWords());
      const data = carryTokens(game.toJSON(), record);
      const next = { id: record.id, seq: record.seq + 1, game: data };
      if (!(await store.put(KEY(record.id), next, record.seq))) {
        return { status: 409, data: { error: 'the game changed underneath you — try again' } };
      }
      return { status: 200, data: view(next, playerId) };
    }

    if (action === 'state') {
      const game = await loadGame(record);
      if (game.tickClock()) {
        const data = carryTokens(game.toJSON(), record);
        const next = { id: record.id, seq: record.seq + 1, game: data };
        if (await store.put(KEY(record.id), next, record.seq)) {
          return { status: 200, data: view(next, playerId) };
        }
        // Someone else rolled it over concurrently; serve what we have.
        return { status: 200, data: view(record, playerId) };
      }
      if (body.since != null && Number(body.since) === record.seq) {
        return { status: 200, data: { seq: record.seq, unchanged: true } };
      }
      return { status: 200, data: view(record, playerId) };
    }

    if (action === 'move') {
      const game = await loadGame(record);
      const result = game.apply({ ...body.move, playerId });
      const nonTurn = NON_TURN_MOVES.includes(body.move?.type);
      if (!nonTurn && game.players.some((p) => p.isCpu)) {
        runCpuTurns(game, await cpuWords());
      }
      // A removal renumbers the seats below it — tokens (and my own id)
      // follow the map the engine handed back.
      const data = carryTokens(game.toJSON(), record, result?.map);
      const me = result?.map ? result.map[playerId] : playerId;
      const next = { id: record.id, seq: record.seq + 1, game: data };
      if (!(await store.put(KEY(record.id), next, record.seq))) {
        return { status: 409, data: { error: 'someone moved at the same time — try again' } };
      }
      return { status: 200, data: { ...view(next, me), result } };
    }

    return { status: 400, data: { error: `unknown action: ${action}` } };
  } catch (err) {
    if (err instanceof GameError) return { status: 400, data: { error: err.message } };
    if (err.status) return { status: err.status, data: { error: err.message } };
    throw err;
  }
}

// --------------------------------------------------------- Vercel handler

export default async function handler(req, res) {
  const store = envStore();
  if (!store) {
    res.status(501).json({
      error:
        'online play is not configured: add the "Upstash for Redis" integration to this Vercel project',
    });
    return;
  }
  const body = req.method === 'GET' ? { ...req.query, action: 'state' } : req.body ?? {};
  try {
    const { status, data } = await handleAction(store, body);
    res.status(status).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
}
