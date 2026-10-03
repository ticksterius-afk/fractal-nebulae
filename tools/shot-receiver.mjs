// Screenshot receiver for tools/devtools.js `__shot(name)` (dev only; for browser panes whose own
// screenshots fail or time out). Listens on 127.0.0.1:5199 and writes each posted canvas JPEG
// ({ name, data: 'data:image/jpeg;base64,…' }) to <dir>/<name>.jpg; the response is the file path.
//
//   npm run shots [-- <dir>]      (or: node tools/shot-receiver.mjs [dir])
//
// <dir> defaults to <OS temp>/fractal-nebulae-shots, outside the repository. Only pages served from a
// local host (localhost, 127.0.0.1, [::1], *.localhost — the Vite dev server) may post; bodies are
// capped at 32 MB.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 5199;
const MAX_BODY = 32 * 1024 * 1024;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?$/i;

const dir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'fractal-nebulae-shots'));
fs.mkdirSync(dir, { recursive: true });

http
  .createServer((req, res) => {
    const origin = req.headers.origin;
    // No Origin header: a local script (curl, Node). Any other page is refused before reading the body.
    if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) {
      res.statusCode = 403;
      res.end('origin not allowed');
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('POST { name, data } only');
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.statusCode = 413;
        res.end('too large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const { name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(data));
        if (!m) throw new Error('data must be a JPEG data URL');
        const base = String(name ?? 'shot').replace(/[^\w.-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'shot';
        const file = path.join(dir, `${base}.jpg`);
        fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
        res.end(file);
      } catch (e) {
        res.statusCode = 400;
        res.end(String(e));
      }
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`shot receiver on http://127.0.0.1:${PORT}/ → ${dir}`));
