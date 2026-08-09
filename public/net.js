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
    const d = await api({ action: 'create', name });
    const session = new Online({ id: d.id, playerId: d.you, token: d.token });
    session.save();
    return { session, view: d };
  }

  static async join(id, name) {
    const d = await api({ action: 'join', id, name });
    const session = new Online({ id, playerId: d.you, token: d.token });
    session.save();
    return { session, view: d };
  }

  state(since) {
    return api({
      action: 'state', id: this.id, playerId: this.playerId, token: this.token, since,
    });
  }

  move(move) {
    return api({
      action: 'move', id: this.id, playerId: this.playerId, token: this.token, move,
    });
  }
}
