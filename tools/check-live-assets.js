/*
 * check-live-assets.js — does the deployed site actually serve these bytes?
 *   (node tools/check-live-assets.js [--base=<url>] [--wait=<seconds>])
 *
 * WHY THIS EXISTS
 * Two files here are GitHub LFS — game/index.pck (328 MB) and
 * 3rdshooter-abootonthebrave/3rdpersonidle.fbx (115 MB) — and a pointer is a
 * perfectly well-behaved web response: HTTP 200, the right content type, a
 * believable-looking body. It is 134 bytes of text instead of the file. A checkout
 * that never ran `git lfs install`, and a Pages build taken from the branch rather
 * than from the Actions artifact, both publish the pointer, and the page that
 * consumes it fails in the browser with nothing in the build to explain why. That is
 * not hypothetical: it is what the live site did on and off while the boot game's
 * models were being converted, and it exhausted the LFS bandwidth behind the Over
 * The Ice pack before that. Nothing in the deploy checked what the deployed URL
 * actually served.
 *
 * WHAT IT CHECKS, and why every check is a few hundred bytes
 * Each path gets one ranged GET — `Range: bytes=0-255` — which answers three
 * questions at once without ever pulling the file: the status, the total size of the
 * resource (from Content-Range), and the first bytes of it. A host that ignores the
 * range would start streaming the whole thing, so the socket is destroyed as soon as
 * the first chunk is in hand; nothing here downloads 328 MB to look at a header. A
 * path fails if it is missing, if it begins with the LFS pointer marker, if it does
 * not begin with the format its consumer will try to parse, or if what came back is
 * too small to be the file. The size is a floor, not an exact figure, so regenerating
 * a model smaller than before does not fail the check — only a stub does. The size
 * test is skipped when the host does not report one, because the header and pointer
 * tests have already established that a real file is there.
 *
 * Requests go out on http/https with `agent: false` rather than through fetch: one
 * socket per probe, closed with the probe, so the process exits with the code it
 * means to. A pooled keep-alive socket left open by an early exit crashes the
 * runtime on Windows and reports 127 instead of the failure.
 *
 * The dotfile probe at the end is a hint, not a verdict: only an artifact built from
 * a full checkout carries dotfiles, so a 200 there means the Actions artifact is what
 * the host is currently serving, and a 404 means the branch build has won again. It
 * is reported because it is the cheapest way to name which pipeline is live.
 */
const http = require('http');
const https = require('https');

const POINTER_PREFIX = 'version https://git-lfs.github.com/spec/';
const SITE = 'https://artistesoundbox.github.io/vitahuesosite';
const RETRY_MS = 15000;
const TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

/* magic is the opening run of characters of the real file, so a stub or an HTML
   error page cannot pass as the payload: glTF binary, Kaydara FBX, Godot's GDPC
   pack header. */
const ASSETS = [
  { path: '3rdshooter-abootonthebrave/3rdpersonidle.glb', magic: 'glTF', floor: 1e6,
    what: 'the officer the boot game draws' },
  { path: '3rdshooter-abootonthebrave/attackerIdle.glb', magic: 'glTF', floor: 1e6,
    what: 'the attacker the boot game draws' },
  { path: '3rdshooter-abootonthebrave/3rdpersonidle.fbx', magic: 'Kaydara', floor: 1e8,
    what: 'the officer master (LFS)' },
  { path: 'game/index.pck', magic: 'GDPC', floor: 1e8,
    what: 'the Over The Ice pack (LFS)' }
];

/* The one path whose presence distinguishes the two publishing pipelines. */
const PIPELINE_HINT = '3rdshooter-abootonthebrave/brokenboot/.gitignore';

function parseArgs(argv) {
  const opts = { base: SITE, wait: 0 };
  argv.forEach(function (arg) {
    const m = /^--(base|wait)(?:=(.*))?$/.exec(arg);
    if (!m) {
      console.log('usage: node tools/check-live-assets.js [--base=<url>] [--wait=<seconds>]');
      process.exit(2);
    }
    if (m[1] === 'base') {
      // A trailing slash is how Pages reports its own page_url, so it is trimmed
      // rather than handed to the path join below.
      opts.base = (m[2] || '').replace(/\/+$/, '');
      if (!opts.base) {
        console.log('--base needs a site URL, e.g. --base=https://example.com/site');
        process.exit(2);
      }
    } else opts.wait = Number(m[2] || 0);
  });
  return opts;
}

function totalSize(headers) {
  const range = headers['content-range'];
  if (range) {
    const slash = range.lastIndexOf('/');
    if (slash >= 0) {
      const n = Number(range.slice(slash + 1));
      if (Number.isFinite(n)) return n;
    }
  }
  const len = Number(headers['content-length']);
  return Number.isFinite(len) ? len : 0;
}

function probe(url, redirects) {
  const hops = redirects || 0;
  return new Promise(function (resolve) {
    let done = false;
    const settle = function (result) {
      if (done) return;
      done = true;
      resolve(result);
    };
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'GET',
      headers: { Range: 'bytes=0-255' },
      agent: false,
      timeout: TIMEOUT_MS
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < MAX_REDIRECTS) {
        res.resume();
        const next = new URL(res.headers.location, target).toString();
        return settle(probe(next, hops + 1));
      }
      let head = Buffer.alloc(0);
      res.on('data', function (chunk) {
        if (!head.length) {
          head = Buffer.from(chunk);
          res.destroy();   // the first chunk is all this check needs, whatever the size asked for
        }
      });
      res.on('end', function () {
        settle({ status: res.statusCode, total: totalSize(res.headers), head: head });
      });
      res.on('close', function () {
        settle({ status: res.statusCode, total: totalSize(res.headers), head: head });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timed out after ' + TIMEOUT_MS + 'ms')); });
    req.on('error', function (err) {
      settle({ status: 0, total: 0, head: Buffer.alloc(0), error: err.message });
    });
    req.end();
  });
}

function classify(asset, res) {
  if (res.error) return { ok: false, why: 'request failed: ' + res.error };
  if (res.status === 404) return { ok: false, why: 'not on the site (404)' };
  if (res.status !== 200 && res.status !== 206) {
    return { ok: false, why: 'answered HTTP ' + res.status };
  }
  const head = res.head.toString('latin1');
  if (head.indexOf(POINTER_PREFIX) === 0) {
    return { ok: false, why: 'is the LFS pointer, not the file (' + res.total + ' bytes)' };
  }
  const magic = head.slice(0, asset.magic.length);
  if (magic !== asset.magic) {
    return { ok: false, why: 'starts with "' + magic + '", not "' + asset.magic + '"' };
  }
  if (res.total && res.total < asset.floor) {
    return { ok: false, why: 'only ' + res.total + ' bytes, too small to be the file' };
  }
  const size = res.total ? (res.total / 1048576).toFixed(2) + ' MB' : 'size not reported';
  return { ok: true, why: size + ', ' + asset.magic };
}

function report(base, results) {
  console.log('live assets at ' + base);
  results.forEach(function (r) {
    console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.asset.path);
    console.log('          ' + r.asset.what + ' — ' + r.why);
  });
  const failed = results.filter(function (r) { return !r.ok; });
  console.log(failed.length
    ? '  ' + failed.length + ' of ' + results.length + ' assets are not being served'
    : '  all ' + results.length + ' assets are served as real files');
  return failed;
}

async function probePipeline(base) {
  const res = await probe(base + '/' + PIPELINE_HINT, 0);
  // 206 as well as 200: the probe asks for a byte range, and a host that supports
  // ranges answers for a file that is there either way.
  if (res.status === 200 || res.status === 206) {
    return 'the Actions artifact is publishing (dotfiles are served)';
  }
  if (res.status === 404) return 'the branch build is publishing (dotfiles are excluded)';
  return 'could not tell which pipeline is publishing (HTTP ' + res.status + ')';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + opts.wait * 1000;
  for (;;) {
    const results = [];
    for (const asset of ASSETS) {
      const verdict = classify(asset, await probe(opts.base + '/' + asset.path, 0));
      results.push({ asset: asset, ok: verdict.ok, why: verdict.why });
    }
    const failed = results.filter(function (r) { return !r.ok; });
    if (!failed.length || Date.now() >= deadline) {
      const bad = report(opts.base, results);
      console.log('  ' + await probePipeline(opts.base));
      if (bad.length) {
        console.log('\nThe site is serving something other than the payload. A pointer means the');
        console.log('deployed tree was built without `lfs: true` — or that Pages is sourcing the');
        console.log('branch build instead of the Actions artifact (Settings -> Pages -> Build and');
        console.log('deployment -> Source: GitHub Actions).');
        process.exitCode = 1;
      }
      return;
    }
    console.log('not ready yet (' + failed.length + ' failing), retrying in ' +
      (RETRY_MS / 1000) + 's — the CDN may still be propagating');
    await new Promise(function (r) { setTimeout(r, RETRY_MS); });
  }
}

main().catch(function (err) {
  console.error('check failed to run: ' + ((err && err.stack) ? err.stack : err));
  process.exitCode = 1;
});
