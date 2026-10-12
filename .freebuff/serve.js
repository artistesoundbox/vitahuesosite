/* throwaway static server for local preview checks (node .freebuff/serve.js 8123)
   Range requests are supported so a media element can seek — without them a
   browser refuses to seek in an <audio> tag and a track end cannot be tested
   locally the way it happens on Pages, which does serve ranges. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const port = Number(process.argv[2] || 8123);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json', '.svg': 'image/svg+xml' };
http.createServer(function (req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('no'); return; }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  fs.stat(file, function (err, st) {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404 ' + p); return; }
    if (range) {
      const start = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
      const end = range[2] === '' || range[1] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1);
      if (start >= st.size || end < start) {
        res.writeHead(416, { 'content-range': 'bytes */' + st.size }); res.end(); return;
      }
      res.writeHead(206, {
        'content-type': type,
        'content-range': 'bytes ' + start + '-' + end + '/' + st.size,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1
      });
      fs.createReadStream(file, { start: start, end: end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, '127.0.0.1', function () { console.log('serving ' + root + ' on http://127.0.0.1:' + port); });
