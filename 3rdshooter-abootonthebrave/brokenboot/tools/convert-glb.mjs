// Dev-only. Converts a character mesh from FBX to GLB with downscaled textures,
// so the game can ship it as an ordinary file instead of a 115 MB Git LFS blob.
//
// WHY IT RUNS IN A BROWSER
// The conversion is done by the page this server hosts (tools/convert-page.html),
// using the same vendored three, the same FBXLoader and the same GLTFExporter the
// game itself uses. That matters more than it sounds: FBX stores centimetres,
// Blender re-scales on import and rewrites bone names, and this rig is load-bearing
// — the boot sockets are hand-tuned against `mixamorigRightFoot`'s own centimetre
// axes, and the animation clips in the repo bind to the mesh by bone name. Loading
// the file with three's loader and writing it back with three's exporter keeps the
// node names, the bind matrices, the skin weights and the units exactly as the game
// already sees them, so nothing downstream has to be retuned. Only the textures
// change, and only in resolution.
//
// USAGE
//   node tools/convert-glb.mjs             # then open the printed URL
//   open http://127.0.0.1:8777/                     — officer
//   open http://127.0.0.1:8777/?mesh=attackerIdle.fbx&out=attackerIdle.glb
//
// The page posts the finished bytes back here and this process writes them into
// 3rdshooter-abootonthebrave/. Nothing is written until the conversion succeeds.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME = resolve(HERE, '..');
const REPO = resolve(GAME, '..', '..');
const ASSET_DIR = '3rdshooter-abootonthebrave';
const EXPORTER = join(GAME, 'node_modules/three/examples/jsm/exporters/GLTFExporter.js');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.fbx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
};

/** Keep every served path inside the repository. */
function safeJoin(root, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const full = join(root, clean);
  return full.startsWith(root) ? full : null;
}

async function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  try {
    if (req.method === 'POST' && url.pathname === '/save') {
      const out = url.searchParams.get('out') || '';
      if (!/^[\w.()-]+\.glb$/.test(out)) return send(res, 400, 'bad output name');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (bytes.length < 1024 || bytes.readUInt32LE(0) !== 0x46546c67) {
        return send(res, 400, `refused: ${bytes.length} bytes is not a GLB`);
      }
      const target = join(REPO, ASSET_DIR, out);
      await writeFile(target, bytes);
      console.log(`wrote ${target} (${(bytes.length / 1048576).toFixed(2)} MB)`);
      return send(res, 200, `wrote ${out}: ${bytes.length} bytes`);
    }

    if (url.pathname === '/') {
      return send(res, 200, await readFile(join(HERE, 'convert-page.html')), TYPES['.html']);
    }

    // The exporter is not vendored — the site never needs it — so it is served
    // straight out of node_modules for the duration of a conversion.
    if (url.pathname === '/exporter/GLTFExporter.js') {
      return send(res, 200, await readFile(EXPORTER), TYPES['.js']);
    }

    const file = safeJoin(REPO, url.pathname);
    if (!file) return send(res, 403, 'forbidden');
    const body = await readFile(file);
    return send(res, 200, body, TYPES[extname(file).toLowerCase()] || 'application/octet-stream');
  } catch (err) {
    return send(res, err.code === 'ENOENT' ? 404 : 500, String(err && err.message ? err.message : err));
  }
});

// An explicit port, never `process.env.PORT` alone: this machine exports PORT=0,
// which would bind a random port and print a URL nobody can open.
const port = Number(process.argv[2]) || 8777;
server.listen(port, '127.0.0.1', () => {
  console.log(`converter listening on http://127.0.0.1:${port}/`);
  console.log(`assets served from ${REPO}`);
});
