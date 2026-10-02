// Local preview: the app, the Worker, and fake AI + Scryfall servers, all on this machine.
//   node tests/dev-server.mjs            (Anthropic-style mock)
//   node tests/dev-server.mjs gemini     (Gemini-style mock)
// Then open http://127.0.0.1:8080
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/worker.js';
import { startMocks } from './mock-upstream.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provider = process.argv[2] === 'gemini' ? 'gemini' : 'anthropic';
const SITE_PORT = Number(process.env.SITE_PORT || 8080);
const WORKER_PORT = Number(process.env.WORKER_PORT || 8787);
const mocks = await startMocks(Number(process.env.MOCK_PORT || 8790), { slow: Number(process.env.MOCK_DELAY || 35) });

const env = {
  PROVIDER: provider,
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  GEMINI_API_KEY: 'test-gemini-key',
  ANTHROPIC_BASE_URL: mocks.url,
  GEMINI_BASE_URL: mocks.url,
  ALLOWED_ORIGINS: `http://127.0.0.1:${SITE_PORT},http://localhost:${SITE_PORT}`,
  ...(process.env.ACCESS_CODE ? { ACCESS_CODE: process.env.ACCESS_CODE } : {}),
  // GEMINI_MODEL=gemini-flaky or gemini-overloaded previews the fallback to the backup model.
  ...(process.env.GEMINI_MODEL ? { GEMINI_MODEL: process.env.GEMINI_MODEL } : {}),
};

// Runs the Worker module inside a plain Node HTTP server.
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://127.0.0.1:${WORKER_PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request, env, { waitUntil: () => {} });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (value) res.write(value);
    if (done) break;
  }
  res.end();
}).listen(WORKER_PORT, '127.0.0.1');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    const proxy = process.env.NO_PROXY_URL ? '' : `http://127.0.0.1:${WORKER_PORT}`;
    return res.end(`window.HJA_CONFIG = { proxyUrl: '${proxy}', scryfallBase: '${mocks.url}', symbolBase: '${mocks.url}/sym', rulesUrl: 'data/rules.json' };`);
  }
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(SITE_PORT, '127.0.0.1');

console.log(`App:    http://127.0.0.1:${SITE_PORT}\nWorker: http://127.0.0.1:${WORKER_PORT} (${provider} mock)\nMocks:  ${mocks.url}`);
