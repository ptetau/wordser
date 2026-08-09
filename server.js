// Tiny server for local play: `npm start`, then open http://localhost:8080/
// Serves public/ (same layout Vercel deploys) and mounts the online-play API
// against an in-memory store so internet play can be exercised locally.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { handleAction, memoryStore } from './api/game.js';

const ROOT = new URL('./public/', import.meta.url).pathname;
const PORT = process.env.PORT ?? 8080;
const store = memoryStore();

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
