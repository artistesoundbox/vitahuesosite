// Minimal static server for local development.
// Serves the repository root so the game page can reference ../<asset> files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.argv[2] || 8177);
const host = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'model/obj',
  '.dae': 'model/vnd.collada+xml',
  '.fbx': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body) res.end(body);
  else res.end();
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let target = path.join(root, url);

  if (!target.startsWith(root)) return send(res, 403, {}, 'Forbidden');

  let stat = null;
  try { stat = fs.statSync(target); } catch { /* missing */ }
  if (stat && stat.isDirectory()) {
    target = path.join(target, 'index.html');
    try { stat = fs.statSync(target); } catch { stat = null; }
  }
  if (!stat || !stat.isFile()) return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');

  const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).pipe(res);
});

server.listen(port, host, () => {
  console.log(`brokenboot dev server: http://${host}:${port}/brokenboot/index.html`);
});
