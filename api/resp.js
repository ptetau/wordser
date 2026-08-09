// A minimal dependency-free Redis client speaking RESP over TCP/TLS, for
// environments that provide a REDIS_URL connection string instead of a REST
// endpoint. Supports exactly what the game store needs: single connection,
// commands answered in order, auto-reconnect on the next command after a
// failure.

import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';

const CRLF = '\r\n';

export function encodeCommand(args) {
  let out = `*${args.length}${CRLF}`;
  for (const a of args) {
    const s = String(a);
    out += `$${Buffer.byteLength(s)}${CRLF}${s}${CRLF}`;
  }
  return out;
}

/**
 * Parse one complete reply starting at `pos`. Returns { value, err, next }
 * or null if the buffer does not yet hold a complete reply.
 */
export function parseReply(buf, pos = 0) {
  if (pos >= buf.length) return null;
  const nl = buf.indexOf(CRLF, pos);
  if (nl === -1) return null;
  const type = buf[pos];
  const head = buf.subarray(pos + 1, nl).toString();
  const after = nl + 2;
  switch (String.fromCharCode(type)) {
    case '+':
      return { value: head, next: after };
    case '-':
      return { err: head, next: after };
    case ':':
      return { value: Number(head), next: after };
    case '$': {
      const len = Number(head);
      if (len === -1) return { value: null, next: after };
      if (buf.length < after + len + 2) return null;
      return { value: buf.subarray(after, after + len).toString(), next: after + len + 2 };
    }
    case '*': {
      const count = Number(head);
      if (count === -1) return { value: null, next: after };
      const items = [];
      let p = after;
      for (let i = 0; i < count; i++) {
        const r = parseReply(buf, p);
        if (!r) return null;
        if (r.err) return { err: r.err, next: r.next };
        items.push(r.value);
        p = r.next;
      }
      return { value: items, next: p };
    }
    default:
      return { err: `unexpected RESP type: ${String.fromCharCode(type)}`, next: after };
  }
}

export class RespClient {
  constructor(url, { timeoutMs = 5000 } = {}) {
    this.url = new URL(url);
    this.timeoutMs = timeoutMs;
    this.sock = null;
    this.ready = null;
    this.pending = [];
    this.buf = Buffer.alloc(0);
  }

  #teardown(err) {
    const waiting = this.pending;
    this.pending = [];
    this.buf = Buffer.alloc(0);
    this.sock?.destroy();
    this.sock = null;
    this.ready = null;
    for (const p of waiting) p.reject(err ?? new Error('redis connection lost'));
  }

  #onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.pending.length) {
      const r = parseReply(this.buf, 0);
      if (!r) break;
      this.buf = this.buf.subarray(r.next);
      const p = this.pending.shift();
      clearTimeout(p.timer);
      if (r.err) p.reject(new Error(`redis: ${r.err}`));
      else p.resolve(r.value);
    }
  }

  #connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const u = this.url;
      const opts = { host: u.hostname, port: Number(u.port || 6379) };
      const onUp = () => resolve();
      const sock =
        u.protocol === 'rediss:'
          ? tlsConnect({ ...opts, servername: u.hostname }, onUp)
          : netConnect(opts, onUp);
      sock.setNoDelay(true);
      sock.on('data', (c) => this.#onData(c));
      sock.on('error', (e) => {
        this.#teardown(e);
        reject(e);
      });
      sock.on('close', () => this.#teardown(new Error('redis connection closed')));
      this.sock = sock;
    }).then(async () => {
      const user = decodeURIComponent(this.url.username || '');
      const pass = decodeURIComponent(this.url.password || '');
      if (pass) {
        await this.#write(user && user !== 'default' ? ['AUTH', user, pass] : ['AUTH', pass]);
      }
    });
    return this.ready;
  }

  #write(args) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      entry.timer = setTimeout(() => {
        this.#teardown(new Error(`redis timeout on ${args[0]}`));
      }, this.timeoutMs);
      this.pending.push(entry);
      this.sock.write(encodeCommand(args), (err) => {
        if (err) this.#teardown(err);
      });
    });
  }

  async cmd(args) {
    await this.#connect();
    return this.#write(args);
  }
}
