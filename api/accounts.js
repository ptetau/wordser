// Accounts, so a game can follow you from the sofa to the bus.
//
// Deliberately small: a name, a passphrase, and a session token. The
// passphrase is stretched with scrypt (built into Node, no dependency) over
// a per-account salt, and compared in constant time. Nothing here ever
// returns or logs the hash, and the passphrase itself is never stored.
//
// A session token is 32 random bytes. It stands for the account until it is
// signed out, which is the same bargain the per-seat tokens already make.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const KEY_LEN = 32;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSPHRASE = 8;

const USER = (name) => `wordser:user:${name}`;
const SESSION = (token) => `wordser:sess:${token}`;

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Accounts are addressed case- and space-insensitively, like player names. */
export const accountKey = (name) =>
  String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const cleanName = (name) => {
  const s = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 20);
  if (s.length < 2) throw new AuthError('pick a name of at least two letters');
  return s;
};

async function derive(passphrase, salt) {
  return scrypt(String(passphrase).normalize('NFKC'), salt, KEY_LEN, SCRYPT);
}

const newToken = () => randomBytes(32).toString('hex');

/**
 * Create an account. Returns { name, token } — the token is the only thing
 * the caller should hold on to.
 */
export async function signUp(store, { name, passphrase }) {
  const clean = cleanName(name);
  if (String(passphrase ?? '').length < MIN_PASSPHRASE) {
    throw new AuthError(`a passphrase needs at least ${MIN_PASSPHRASE} characters`);
  }
  const key = accountKey(clean);
  if (await store.get(USER(key))) {
    throw new AuthError('that name is taken — sign in instead?', 409);
  }
  const salt = randomBytes(16);
  const hash = await derive(passphrase, salt);
  const account = {
    name: clean,
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    games: [],
  };
  if (!(await store.setNew(USER(key), account))) {
    throw new AuthError('that name was just taken — try another', 409);
  }
  return { name: clean, token: await openSession(store, key) };
}

/** Check a passphrase and hand back a fresh session token. */
export async function signIn(store, { name, passphrase }) {
  const key = accountKey(name);
  const account = await store.get(USER(key));
  // Derive regardless, so a missing account costs the same as a wrong
  // passphrase and can't be told apart by timing.
  const salt = Buffer.from(account?.salt ?? randomBytes(16).toString('hex'), 'hex');
  const attempt = await derive(passphrase ?? '', salt);
  const stored = Buffer.from(account?.hash ?? randomBytes(KEY_LEN).toString('hex'), 'hex');
  const matches =
    attempt.length === stored.length && timingSafeEqual(attempt, stored) && Boolean(account);
  if (!matches) throw new AuthError('that name and passphrase do not match', 403);
  return { name: account.name, token: await openSession(store, key) };
}

/**
 * Swap the passphrase for a new one, proving the old one first. Sessions
 * already open stay open — including this one, which is the point: changing
 * it shouldn't sign you out of the game you are in the middle of.
 */
export async function changePassphrase(store, key, { current, passphrase }) {
  const account = await store.get(USER(key));
  if (!account) throw new AuthError('sign in first', 403);
  const attempt = await derive(current ?? '', Buffer.from(account.salt, 'hex'));
  const stored = Buffer.from(account.hash, 'hex');
  if (!(attempt.length === stored.length && timingSafeEqual(attempt, stored))) {
    throw new AuthError('that is not your current passphrase', 403);
  }
  if (String(passphrase ?? '').length < MIN_PASSPHRASE) {
    throw new AuthError(`a passphrase needs at least ${MIN_PASSPHRASE} characters`);
  }
  const salt = randomBytes(16);
  const hash = await derive(passphrase, salt);
  await store.set(USER(key), {
    ...account,
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
  });
  return { name: account.name };
}

async function openSession(store, key) {
  const token = newToken();
  await store.set(SESSION(token), { account: key });
  return token;
}

/** Whose account is this token? Null when it means nothing. */
export async function whoIs(store, token) {
  if (!token) return null;
  const session = await store.get(SESSION(token));
  if (!session?.account) return null;
  const account = await store.get(USER(session.account));
  return account ? { key: session.account, name: account.name, games: account.games ?? [] } : null;
}

/** Forget a session token. The account and its games are untouched. */
export async function signOut(store, token) {
  if (!token) return;
  await store.del(SESSION(token));
}

/** Remember that this account is in this game, most recent first. */
export async function rememberGame(store, key, gameId) {
  const account = await store.get(USER(key));
  if (!account) return;
  const games = [gameId, ...(account.games ?? []).filter((g) => g !== gameId)].slice(0, 40);
  await store.set(USER(key), { ...account, games });
}
