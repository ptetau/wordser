// The wordser server: serves public/ and the online-play API.
//
// This entrypoint runs BOTH locally (`npm start`) and on Vercel, whose Node
// server detection runs it in production. The store therefore prefers real
// Redis whenever the environment provides it, and only falls back to the
// in-memory store for local development — an in-memory store on a serverless
// runtime silently loses every game when the instance recycles.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { handleAction, envStore, memoryStore } from './api/game.js';

const ROOT = new URL('./public/', import.meta.url).pathname;
const PORT = process.env.PORT ?? 8080;
const store = envStore() ?? memoryStore();
console.log(`wordser store: ${store.diag ? 'redis' : 'in-memory (local dev only)'}`);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/game') {
    try {
      const body =
        req.method === 'GET'
          ? { ...Object.fromEntries(url.searchParams), action: 'state' }
          : JSON.parse((await readBody(req)) || '{}');
      const { status, data } = await handleAction(store, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
    return;
  }
  try {
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) throw new Error('nope');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, () => {
  console.log(`wordser at http://localhost:${PORT}/`);
});
