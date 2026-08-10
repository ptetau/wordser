// Thin client for the online-play API.

export class NetError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(body) {
  let r;
  try {
    r = await fetch('/api/game', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new NetError('network error — are you offline?', 0);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new NetError(data.error ?? `request failed (${r.status})`, r.status);
  return data;
}

const credsKey = (id) => `wordser:${id}`;
const ACCOUNT_KEY = 'wordser:account';

/**
 * The signed-in account, if any. Held here so every request can carry it:
 * the server treats it as proof of the seats that belong to you, whatever
 * device you are on.
 */
export const account = {
  get() {
    try {
      return JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? 'null');
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      if (value) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(value));
      else localStorage.removeItem(ACCOUNT_KEY);
    } catch {}
  },
  token() {
    return this.get()?.token ?? undefined;
  },
  async signUp(name, passphrase) {
    const d = await api({ action: 'signup', name, passphrase });
    this.set({ name: d.account, token: d.accountToken });
    return d;
  },
  async signIn(name, passphrase) {
    const d = await api({ action: 'signin', name, passphrase });
    this.set({ name: d.account, token: d.accountToken });
    return d;
  },
  async signOut() {
    const token = this.token();
    this.set(null);
    if (token) await api({ action: 'signout', accountToken: token }).catch(() => {});
  },
  myGames() {
    return api({ action: 'mygames', accountToken: this.token() });
  },

  changePassphrase(current, next) {
    return api({ action: 'changepass', accountToken: this.token(), current, passphrase: next });
  },
};

const RECENT_KEY = 'wordser:recent';
const RECENT_MAX = 12;

/**
 * Games this browser has sat at, newest first. The account knows your games
 * wherever you are, but a guest has only what this device remembers — and
 * even signed in it means the list is on screen before the network answers.
 */
export const recent = {
  list() {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  },
  remember(entry) {
    if (!entry?.id) return;
    const rest = this.list().filter((g) => g.id !== entry.id);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...rest].slice(0, RECENT_MAX)));
    } catch {}
  },
  forget(id) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(this.list().filter((g) => g.id !== id)));
    } catch {}
  },
};

export class Online {
  constructor({ id, playerId, token }) {
    this.id = id;
    this.playerId = playerId;
    this.token = token;
  }

  static saved(id) {
    try {
      const raw = localStorage.getItem(credsKey(id));
      return raw ? new Online({ id, ...JSON.parse(raw) }) : null;
    } catch {
      return null;
    }
  }

  save() {
    try {
      localStorage.setItem(credsKey(this.id), JSON.stringify({ playerId: this.playerId, token: this.token }));
    } catch {
      // Private browsing without storage: the session just won't survive reloads.
    }
  }

  static async create(name) {
    const d = await api({ action: 'create', name, accountToken: account.token() });
    const session = new Online({ id: d.id, playerId: d.you, token: d.token });
    session.save();
    return { session, view: d };
  }

  static async join(id, name) {
    const d = await api({ action: 'join', id, name, accountToken: account.token() });
    const session = new Online({ id, playerId: d.you, token: d.token });
    session.save();
    return { session, view: d };
  }

  /**
   * Step back into a seat you already hold, using the account alone — the
   * way a game you started on one device opens on another.
   */
  static async adopt(id) {
    const d = await api({ action: 'state', id, accountToken: account.token() });
    if (d.you == null) throw new NetError('no seat of yours in that game', 403);
    const session = new Online({ id, playerId: d.you, token: null });
    session.save();
    return { session, view: d };
  }

  state(since) {
    return api({
      action: 'state', id: this.id, playerId: this.playerId, token: this.token, since,
      accountToken: account.token(),
    });
  }

  move(move) {
    return api({
      action: 'move', id: this.id, playerId: this.playerId, token: this.token, move,
      accountToken: account.token(),
    });
  }

  addCpu() {
    return api({
      action: 'addcpu', id: this.id, playerId: this.playerId, token: this.token,
      accountToken: account.token(),
    });
  }
}
