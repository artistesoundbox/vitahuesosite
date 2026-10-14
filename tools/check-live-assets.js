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
 * The workers themselves are checked too, because the pack guard is a file they
 * import (pack-guard.js) and a worker deployed without it does not install at all:
 * a whole-body fetch of each script, capped, asserts the marker that proves the
 * deployed copy is the guarded one rather than the one that shipped before it.
 *
 * The dotfile probe at the end is a hint, not a verdict: only an artifact built from
 * a full checkout carries dotfiles, so a 200 there means the Actions artifact is what
 * the host is currently serving, and a 404 means the branch build has won again. It
 * is reported because it is the cheapest way to name which pipeline is live.
 *
 * The entry points are checked last, and they are why this tool reads anything off
 * disk. A launcher page can open a game that has no guard at all: the portal's
 * SEBLERSKERS page opens a stock export on another host, which loads no pack guard and
 * registers a worker that imports none, while the guarded shell it should open sits one
 * directory away. So every root HTML file in the checkout is fetched as deployed, every
 * way that page points at another page is resolved — a link or an iframe, a named
 * constant, a window opened in script, a navigation call, a src set through the DOM —
 * and every target that turns out to be a pack build must load
 * pack-guard.js; if it registers a worker, that worker must import the guard as well.
 * The launcher page itself is not required to load the guard: the guard belongs to the
 * page the engine runs in. A page that announces no pack is not a game page and the
 * guard says nothing about it, which is what keeps a menu link from reading as a
 * failure. Failures name the launcher, not just the build, because the launcher is the
 * thing to change.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

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

/* Files the pack workers cannot run without. A missing or stale one is not a
   broken pack — both workers throw while installing and the browser keeps the
   worker it already had — but it does mean the guard is not what is deployed,
   and a worker from before the guard serves a 134-byte pointer happily. So the
   marker is checked, not just the status: it is what distinguishes the guarded
   worker from the one that shipped before it. */
const SCRIPTS = [
  { path: 'pack-guard.js', floor: 1024, marker: 'function guardPack',
    what: 'the shared stub guard both pack workers import' },
  { path: 'seblerskers/site-sw.js', floor: 4096,
    marker: 'importScripts("../pack-guard.js")',
    what: 'the portal pack worker, importing that guard' },
  { path: 'game/sw-pack.js', floor: 4096,
    marker: "importScripts('../pack-guard.js')",
    what: "Over The Ice's pack worker, importing that guard" }
];
const MAX_SCRIPT_BYTES = 262144;

/* ---------------------------------------------------------------------------
 * ENTRY POINTS
 *
 * A guard in the shells only helps the player who reaches a shell, so every way into
 * the site is checked: each launcher page, every game it opens, and whether that game
 * carries the guard.
 */
const GUARD_FILE = 'pack-guard.js';
const GUARD_IMPORT = 'importScripts';
const PACK_MARKER = '.pck';
/* Large enough for a portal page (the biggest here is ~260 KB) and far too small to
   pull a pack, so a launcher pointing straight at one cannot stream it through here. */
const MAX_PAGE_BYTES = 1048576;
const NON_PAGE = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|mp4|webm|mov|ogv|mp3|wav|ogg|webmanifest|woff2?|map|json|txt|md|glb|gltf|fbx|wasm|zip|ttf|otf)([?#]|$)/i;

/* Root HTML files — the portal's own pages, which is where a launcher lives. */
function launcherFiles(root) {
  try {
    return fs.readdirSync(root).filter(function (f) { return /\.html?$/i.test(f); }).sort();
  } catch (e) {
    return [];
  }
}

/* Every way a page can open something — written as spellings of "this page points at
   that page" rather than as the handful of spellings this site happens to use today.
   A launcher whose mechanism is not on this list is a way into a game that this check
   cannot see, which is the one failure mode it must not have:
     - the site's own constant (GAME_URL = '...')
     - a navigation, by assignment or call: location.href =, window.location =,
       top/parent/document/self variants, location.assign(), location.replace()
     - a window: window.open(), self/top.open(), a bare open()
     - a src/href/action property set on any element, whoever it belongs to:
       frame.src =, panel.src = — so the receiver is deliberately not named
     - the same through the DOM API: setAttribute('src', ...)
     - markup that loads a document in place or navigates: iframe, frame, embed,
       object, a, area, form
     - markup that redirects: <meta http-equiv="refresh" content="0; url=...">

   Over-reading is harmless: a target is judged only after it turns out to be a pack
   build, so an image, a stylesheet, a menu link or a 404 is dropped without a verdict.
   Under-reading is not harmless, so where the two disagree this list reads wide. */
const LAUNCH_SOURCES = [
  /(?:GAME_URL|GAME_PATH|GAME_SRC|GAME_HREF)\s*=\s*['"]([^'"]+)['"]/g,
  /\b(?:window|document|top|parent|self)\s*\.\s*location\s*(?:\.\s*(?:href|assign|replace)\s*)?(?:\(|=)\s*['"]([^'"]+)['"]/g,
  /\blocation\s*(?:\.\s*(?:href|assign|replace)\s*)?(?:\(|=)\s*['"]([^'"]+)['"]/g,
  /\b(?:window|self|top|parent)\s*\.\s*open\s*\(\s*['"]([^'"]+)['"]/g,
  /(?<![.\w$])open\s*\(\s*['"]([^'"]+)['"]/g,
  /\.\s*(?:src|href|action)\s*=\s*['"]([^'"]+)['"]/g,
  /setAttribute\s*\(\s*['"](?:src|href|action)['"]\s*,\s*['"]([^'"]+)['"]/g,
  /<(?:iframe|frame|embed|object|a|area|form)\b[^>]*?\b(?:src|href|data|action)\s*=\s*["']([^"']+)["']/gi,
  /<meta\b[^>]*?http-equiv\s*=\s*["']?refresh["']?[^>]*?\burl\s*=\s*['"]?([^"';>\s]+)/gi,
  /<meta\b[^>]*?\burl\s*=\s*['"]?([^"';>\s]+)[^>]*?http-equiv\s*=\s*["']?refresh["']?/gi
];

/* Addresses of pages, resolved against the launcher they came from and stripped of
   duplicates. Anything that is not a page — an anchor, a stylesheet, a video, an
   analytics beacon — is dropped before a single request goes out. */
function launchTargets(html, pageUrl) {
  const out = [];
  const seen = {};
  LAUNCH_SOURCES.forEach(function (re) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html)) !== null) {
      const raw = m[1].trim();
      if (!raw || /^(#|about:|javascript:|data:|mailto:|tel:)/i.test(raw)) continue;
      if (NON_PAGE.test(raw)) continue;
      let url;
      try { url = new URL(raw, pageUrl); } catch (e) { continue; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      url.hash = '';
      const key = url.toString();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(key);
    }
  });
  return out;
}

function displayTarget(url, base) {
  if (url.indexOf(base + '/') === 0) return decodeURIComponent(url.slice(base.length + 1));
  return url;
}

/* What a launcher opens, described. Only a page that announces a pack it will load is
   a build — that is the page whose fetch the guard exists for. */
async function classifyTarget(url) {
  const res = await probe(url, 0, { range: false, maxBytes: MAX_PAGE_BYTES });
  if (res.error || res.status !== 200) return { kind: 'unreachable' };
  const html = res.head.toString('utf8');
  if (html.indexOf(PACK_MARKER) < 0) return { kind: 'not-a-build' };

  const guarded = html.indexOf(GUARD_FILE) >= 0;
  const registered = /serviceWorker\.register\(\s*['"]([^'"]+)['"]/.exec(html);
  let worker = null;
  if (registered) {
    let workerUrl = null;
    try { workerUrl = new URL(registered[1], url).toString(); } catch (e) { workerUrl = null; }
    if (workerUrl) {
      const w = await probe(workerUrl, 0, { range: false, maxBytes: MAX_PAGE_BYTES });
      const text = w.head.toString('utf8');
      worker = {
        path: new URL(workerUrl).pathname,
        guarded: w.status === 200 &&
          text.indexOf(GUARD_FILE) >= 0 && text.indexOf(GUARD_IMPORT) >= 0
      };
    }
  }
  return { kind: 'build', guarded: guarded, worker: worker };
}

function judgeTarget(verdict) {
  if (!verdict.guarded) {
    return { ok: false,
      why: 'opens a pack build that loads no ' + GUARD_FILE + ' — this way into the game is ' +
        'unguarded, so a 134-byte stub here reaches the engine and fails as a parse error ' +
        'with nothing said' };
  }
  if (verdict.worker && !verdict.worker.guarded) {
    return { ok: false,
      why: 'loads the guard, but the worker it registers (' + verdict.worker.path +
        ') does not import it — the engine fetches the pack through that worker, so that ' +
        'fetch is unguarded' };
  }
  return { ok: true,
    why: verdict.worker
      ? 'the guarded shell, and ' + verdict.worker.path + ' imports the guard'
      : 'the guarded shell (it registers no worker)' };
}

async function checkEntryPoints(base, launchers) {
  const results = [];
  const cache = {};
  let published = 0;
  for (const file of launchers) {
    const pageUrl = base + '/' + file;
    const page = await probe(pageUrl, 0, { range: false, maxBytes: MAX_PAGE_BYTES });
    if (page.status !== 200) continue;   // not on the site, so not a way in
    published++;
    for (const target of launchTargets(page.head.toString('utf8'), pageUrl)) {
      if (!cache[target]) cache[target] = classifyTarget(target);
      const verdict = await cache[target];
      if (verdict.kind !== 'build') continue;
      const judged = judgeTarget(verdict);
      results.push({
        kind: 'entry', ok: judged.ok, why: judged.why,
        asset: { path: file + ' -> ' + displayTarget(target, base),
                 what: 'a game this launcher opens' }
      });
    }
  }
  /* Silence would read as a pass, so an empty result is a failure: it means the page
     set or the launch mechanism changed shape and nothing was actually checked. */
  if (!results.length) {
    results.push({
      kind: 'entry', ok: false,
      asset: { path: 'every launcher in the checkout', what: 'the ways into the pack games' },
      why: 'none of the ' + launchers.length + ' launcher pages opened anything announcing a ' +
        'pack (' + published + ' of them are on the site), so this check proved nothing'
    });
  }
  return results;
}

function reportEntries(entries) {
  console.log('  entry points — every launcher\u2019s game target must carry the pack guard');
  entries.forEach(function (r) {
    console.log('    ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.asset.path);
    console.log('            ' + r.asset.what + ' — ' + r.why);
  });
  const failed = entries.filter(function (r) { return !r.ok; });
  console.log(failed.length
    ? '    ' + failed.length + ' of ' + entries.length + ' ways into a pack game are unguarded'
    : '    all ' + entries.length + ' ways into a pack game are guarded');
  return failed;
}

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

function probe(url, redirects, opts) {
  const hops = redirects || 0;
  const options = opts || {};
  const wholeBody = options.range === false;
  const maxBytes = options.maxBytes || 0;
  return new Promise(function (resolve) {
    let done = false;
    const settle = function (result) {
      if (done) return;
      done = true;
      resolve(result);
    };
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const headers = {};
    if (!wholeBody) headers.Range = 'bytes=0-255';
    const req = lib.request(target, {
      method: 'GET',
      headers: headers,
      agent: false,
      timeout: TIMEOUT_MS
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < MAX_REDIRECTS) {
        res.resume();
        const next = new URL(res.headers.location, target).toString();
        return settle(probe(next, hops + 1, options));
      }
      const parts = [];
      let size = 0;
      res.on('data', function (chunk) {
        parts.push(Buffer.from(chunk));
        size += chunk.length;
        // A ranged request needs only its first chunk. A whole-body request — a
        // script whose marker could be anywhere in it — is capped, so a wrong
        // URL cannot pull a pack through this check.
        if (!wholeBody || size > maxBytes) res.destroy();
      });
      const finish = function () {
        settle({ status: res.statusCode, total: totalSize(res.headers), head: Buffer.concat(parts) });
      };
      res.on('end', finish);
      res.on('close', finish);
    });
    req.on('timeout', function () { req.destroy(new Error('timed out after ' + TIMEOUT_MS + 'ms')); });
    req.on('error', function (err) {
      settle({ status: 0, total: 0, head: Buffer.alloc(0), error: err.message });
    });
    req.end();
  });
}

/* The guard itself, and the two workers that must be importing it. */
async function checkScripts(base) {
  const results = [];
  for (const script of SCRIPTS) {
    const res = await probe(base + '/' + script.path, 0,
      { range: false, maxBytes: MAX_SCRIPT_BYTES });
    const asset = { path: script.path, what: script.what };
    if (res.error) {
      results.push({ asset: asset, ok: false, why: 'request failed: ' + res.error });
    } else if (res.status === 404) {
      results.push({ asset: asset, ok: false, why: 'not on the site (404)' });
    } else if (res.status !== 200) {
      results.push({ asset: asset, ok: false, why: 'answered HTTP ' + res.status });
    } else if (res.total && res.total < script.floor) {
      results.push({ asset: asset, ok: false, why: 'only ' + res.total + ' bytes' });
    } else if (res.head.toString('utf8').indexOf(script.marker) < 0) {
      results.push({ asset: asset, ok: false,
        why: 'is served, but without ' + JSON.stringify(script.marker) +
          ' in it \u2014 the deployed copy is not the guarded one' });
    } else {
      const size = res.total ? (res.total / 1024).toFixed(1) + ' KB' : 'size not reported';
      results.push({ asset: asset, ok: true,
        why: size + ', carries ' + script.marker });
    }
  }
  return results;
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
  /* The launcher list comes off disk: a Pages site cannot be listed over HTTP, and the
     launcher that drifts is often the one nothing links to — the SEBLERSKERS launcher
     page is live, opens a build on another host, and is reached by URL, not by a link. */
  const launchers = launcherFiles(path.join(__dirname, '..'));
  const deadline = Date.now() + opts.wait * 1000;
  for (;;) {
    const results = [];
    for (const asset of ASSETS) {
      const verdict = classify(asset, await probe(opts.base + '/' + asset.path, 0));
      results.push({ asset: asset, ok: verdict.ok, why: verdict.why });
    }
    results.push(...await checkScripts(opts.base));
    const entries = await checkEntryPoints(opts.base, launchers);
    const failed = results.concat(entries).filter(function (r) { return !r.ok; });
    if (!failed.length || Date.now() >= deadline) {
      const bad = report(opts.base, results);
      const unguarded = reportEntries(entries);
      console.log('  ' + await probePipeline(opts.base));
      if (bad.length || unguarded.length) {
        console.log('\nThe site is not serving what it should. A pointer means the deployed tree');
        console.log('was built without `lfs: true` — or that Pages is sourcing the branch build');
        console.log('instead of the Actions artifact (Settings -> Pages -> Build and deployment ->');
        console.log('Source: GitHub Actions). A worker served without its guard import means the');
        console.log('deployed copy predates that change, and until it lands those workers answer a');
        console.log('pack URL with whatever the host returns — a pointer included.');
        if (unguarded.length) {
          console.log('A way into a pack game with no guard is a launcher pointed at the wrong');
          console.log('build — or at one that predates the guard. Point it at the guarded shell, or');
          console.log('give that build the guard; until then that way in stays silent when the host');
          console.log('answers with a stub.');
        }
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
