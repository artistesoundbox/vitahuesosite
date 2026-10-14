/*
 * test-launch-sources.mjs — can the entry-point check still see every way into a pack game?
 *   (node tools/test-launch-sources.mjs [--keep])
 *
 * WHY THIS EXISTS
 * check-live-assets.js finishes by asking, for every launcher page in the checkout, what
 * that page opens and whether the build it opens carries the pack guard. That answer is
 * only as good as LAUNCH_SOURCES — the list of spellings that count as "this page points
 * at that page" — and the list is easy to narrow by accident, because narrowing it does
 * not fail, it PASSES: a way in the list cannot see is a way in that is never checked,
 * and the run still ends at 0. Silent under-reporting is the one failure mode a guard
 * check must not have, so the list is tested rather than assumed.
 *
 * HOW
 * One fixture launcher page per mechanism, each reaching its build by exactly ONE
 * mechanism, so the verdict on that page is attributable to that mechanism alone. The
 * fixture is built twice: every launcher pointed at an unguarded build (the run must
 * fail, and name every launcher), and every launcher pointed at the guarded shell (the
 * run must pass, which is also what keeps this test from proving only that the tool can
 * say no). A third build mutates LAUNCH_SOURCES down to a single `<a href>` pattern, and
 * that one has to come out looking like a PASS — one guarded way in, nothing else
 * reported. The mutation run is the regression this test exists to catch, and it is also
 * what shows the exact-entry-set assertion has teeth: if narrowing the list ever stops
 * looking like a pass, the mutation case says so before the fixture cases can be blamed.
 *
 * The fixture is rebuilt from scratch on every run, so it cannot drift away from this
 * file. The tool under test is copied into the fixture rather than re-implemented: the
 * bytes that run are the bytes that ship.
 *
 * NOT COVERED, deliberately: a target held in a variable — `open(URL)`,
 * `location.assign(buildForLevel)` — cannot be resolved without running the page, and
 * the check does not pretend otherwise; chains through a non-root intermediate page; and
 * launchers published but absent from the checkout, which this side of the deploy cannot
 * list at all.
 *
 * WHAT IT PINS: mechanisms, not patterns. Several spellings are matched by more than one
 * pattern — `window.location.href = 'x'` is seen by three of them, `window.open('x')` by
 * one — so a sweep that deletes one pattern at a time will find a redundant spelling
 * surviving once and the mechanism only disappearing when its last pattern goes. That is
 * deliberate: simplifying the list stays free, and a mechanism that stops being seen is
 * what fails here. Verified by that sweep, not assumed: dropping each pattern in turn
 * fails this test for nine of the ten, and dropping `window.location` leaves
 * `location.href =` still found by the plain property pattern.
 *
 * exits 1 if any check fails.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const TOOL = path.join(here, 'check-live-assets.js');
const NODE = process.execPath;
const KEEP = process.argv.includes('--keep');

/* ---------- what the fixture points at ---------- */
const BUILD_OK = 'shell-ok/index.html';               // guarded page AND guarded worker
const BUILD_NOWORKER = 'shell-noworker/index.html';   // guarded page, no worker at all
const BUILD_BAD = 'shell-bad/index.html';             // no guard anywhere
const BUILD_WORKERBAD = 'shell-workerbad/index.html'; // guarded page, worker importing nothing
const NOT_A_BUILD = 'shell-nopack/index.html';        // announces no pack: never reported

/* One case per way a page can open another page. `broken` is where that launcher points
   in the broken fixture and the verdict the check must reach there; `verdict` FAIL means
   that build carries no guard, so the launcher is the thing to change. Every case also
   exists to keep its mechanism on the list: drop the pattern that finds it and the entry
   disappears, which the exact-set assertion below turns into a failure. */
const CASES = [
  {
    file: 'index.html', mechanism: '<a href>', broken: BUILD_OK, verdict: 'PASS',
    shows: 'the mechanism this check has always known, so the broken run has a control that passes',
    body: (t) => `<a href="${t}">Play</a>`
  },
  {
    file: 'constant-frame.html', mechanism: "a GAME_URL constant, then frame.src = GAME_URL",
    broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'the portal\u2019s own two-step spelling: a named constant, then a property set from it',
    body: (t) => `<script>
var GAME_URL = '${t}';
var frame = document.getElementById('g');
frame.src = GAME_URL;
</script>`
  },
  {
    file: 'open-window.html', mechanism: 'window.open()', broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'a game opened in a second window, and a second window opened at a page that is not a build',
    body: (t) => `<script>
window.open('${t}', 'game', 'noopener');
window.open('${NOT_A_BUILD}', 'bonus');
</script>`
  },
  {
    file: 'open-bare.html', mechanism: 'a bare open()', broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'the same call with no receiver in front of it',
    body: (t) => `<script>
open('${t}', '_blank');
</script>`
  },
  {
    file: 'property-src.html', mechanism: 'panel.src = (a receiver not called frame)',
    broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'a src set on an element whose variable is named anything at all',
    body: (t) => `<script>
var panel = document.getElementById('g');
panel.src = '${t}';
</script>`
  },
  {
    file: 'dom-setattribute.html', mechanism: "setAttribute('src', ...)",
    broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'the same src set through the DOM API instead of the property',
    body: (t) => `<script>
document.getElementById('g').setAttribute('src', '${t}');
</script>`
  },
  {
    file: 'location-assign.html', mechanism: 'location.assign()', broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'navigation by call rather than by assignment',
    body: (t) => `<script>location.assign('${t}');</script>`
  },
  {
    file: 'location-href.html', mechanism: 'window.location.href =', broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'the navigation spelling the check knew before it was widened, pinned against an unguarded build',
    body: (t) => `<script>window.location.href = '${t}';</script>`
  },
  {
    file: 'location-replace.html', mechanism: 'top.location.replace()',
    broken: BUILD_WORKERBAD, verdict: 'FAIL',
    shows: 'the other navigation call, aimed at the half-guarded build so the deep verdict is exercised',
    body: (t) => `<script>top.location.replace('${t}');</script>`
  },
  {
    file: 'markup-embed.html', mechanism: '<embed src>', broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'a document loaded in place by markup',
    body: (t) => `<embed src="${t}" type="text/html">`
  },
  {
    file: 'markup-object.html', mechanism: '<object data>', broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'the same, spelled the other way',
    body: (t) => `<object data="${t}" type="text/html"></object>`
  },
  {
    file: 'markup-area.html', mechanism: '<area href>', broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'a mapped hotspot, which is not the <a> the first pattern looks for',
    body: (t) => `<map name="m"><area shape="rect" coords="0,0,9,9" href="${t}" alt="play"></map>`
  },
  {
    file: 'markup-iframe.html', mechanism: '<iframe src>', broken: BUILD_NOWORKER, verdict: 'PASS',
    shows: 'a frame, pointing at a guarded shell that registers no worker',
    body: (t) => `<iframe id="g" src="${t}"></iframe>`
  },
  {
    file: 'markup-form.html', mechanism: '<form action>', broken: BUILD_OK, verdict: 'PASS',
    shows: 'a form post, which navigates like a link',
    body: (t) => `<form action="${t}" method="get"><button type="submit">Play</button></form>`
  },
  {
    file: 'meta-refresh.html', mechanism: 'a meta refresh', broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'a redirect written in markup, with the url inside content',
    body: (t) => `<meta http-equiv="refresh" content="0; url=${t}">`
  },
  {
    file: 'meta-refresh-rev.html', mechanism: 'a meta refresh with the attributes reversed',
    broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'the same tag with content before http-equiv, which no attribute-order-specific pattern would see',
    body: (t) => `<meta content="0; url=${t}" http-equiv="refresh">`
  }
];

const PACK_CONFIG = 'const GODOT_CONFIG = {"fileSizes":{"index.pck":33554432}};';
const padding = (n, ch) => '//'.padEnd(n, ch) + '\n';

let failures = 0;
let harnessFailures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '\n          ' + detail));
  if (!ok) failures++;
}

/* The mutation case is part of this test, not part of the tool under test. When it fails
   because the tool's shape changed (the array was renamed, the source no longer parses)
   the fixture cases may all have passed, and reporting "the check is blind" would be a
   guess dressed as a verdict. So a harness failure is counted, then said for what it is. */
function checkHarness(name, ok, detail) {
  check(name, ok, detail);
  if (!ok) harnessFailures++;
}

/* ---------- the fixture ---------- */

function launcherPage(c, target) {
  return '<!DOCTYPE html>\n<html><head><title>' + c.file + '</title></head>\n<body>\n' +
    c.body(target) + '\n</body></html>\n';
}

/* A tree with the tool under test inside it, so __dirname/.. is the fixture root and the
   launcher list is exactly these pages. Written to a temp dir, never into the checkout:
   a root HTML file planted in the repo would be read by the real check. */
function buildTree(label, toolSource, targetFor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-sources-' + label + '-'));
  const w = (rel, body) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  w(path.join('tools', 'check-live-assets.js'), toolSource);
  for (const c of CASES) w(c.file, launcherPage(c, targetFor(c)));

  /* The guard and the two workers the tool checks directly, with the markers it looks
     for and enough bytes to clear its floors. */
  w('pack-guard.js', '/* fixture guard */\nfunction guardPack() {}\n' + padding(1500, 'x'));
  w('seblerskers/site-sw.js', 'importScripts("../pack-guard.js");\n' + padding(4200, 'w'));
  w('game/sw-pack.js', "importScripts('../pack-guard.js');\n" + padding(4200, 'v'));

  /* The builds themselves. */
  w('shell-ok/index.html', `<!DOCTYPE html><html><head>
<script src="../pack-guard.js"></script>
</head><body><script>
${PACK_CONFIG}
navigator.serviceWorker.register('sw.js').catch(function () {});
</script></body></html>
`);
  w('shell-ok/sw.js', '/* guarded worker */\nimportScripts(\'../pack-guard.js\');\n' + padding(4200, 'y'));

  w('shell-noworker/index.html', `<!DOCTYPE html><html><head>
<script src="../pack-guard.js"></script>
</head><body><script>
${PACK_CONFIG}
</script></body></html>
`);

  w('shell-bad/index.html', `<!DOCTYPE html><html><body><script>
${PACK_CONFIG}
const engine = new Engine(GODOT_CONFIG);
engine.startGame();
</script></body></html>
`);

  w('shell-workerbad/index.html', `<!DOCTYPE html><html><head>
<script src="../pack-guard.js"></script>
</head><body><script>
${PACK_CONFIG}
navigator.serviceWorker.register('sw.js').catch(function () {});
</script></body></html>
`);
  w('shell-workerbad/sw.js', '/* plain cache worker: it never imports the guard */\n' + padding(4200, 'z'));

  w('shell-nopack/index.html', '<!DOCTYPE html><html><body><h1>just a page</h1></body></html>\n');

  return root;
}

/* The four large assets are answered as if they were real files: a 256-byte head that
   starts with the format's magic and a Content-Range naming a full size. Nothing here
   writes 328 MB, and the ranged request the tool makes needs no more than this. */
const ASSETS = {
  '/3rdshooter-abootonthebrave/3rdpersonidle.glb': { magic: 'glTF', total: 8000000 },
  '/3rdshooter-abootonthebrave/attackerIdle.glb': { magic: 'glTF', total: 7000000 },
  '/3rdshooter-abootonthebrave/3rdpersonidle.fbx': { magic: 'Kaydara', total: 200000000 },
  '/game/index.pck': { magic: 'GDPC', total: 330000000 }
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.gitignore': 'text/plain'
};

function serveTree(root) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://placeholder').pathname);
    const asset = ASSETS[p];
    if (asset) {
      const head = Buffer.alloc(256);
      head.write(asset.magic, 0, 'latin1');
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': 'bytes 0-255/' + asset.total,
        'accept-ranges': 'bytes'
      });
      return res.end(head);
    }
    if (p === '/3rdshooter-abootonthebrave/brokenboot/.gitignore') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('node_modules\n');
    }
    const file = path.resolve(root, '.' + p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not here');
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      base: 'http://127.0.0.1:' + server.address().port,
      close: () => server.close()
    }));
  });
}

function runTool(root, base) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [path.join(root, 'tools', 'check-live-assets.js'), '--base=' + base],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the check did not finish within 60s:\n' + out));
    }, 60000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/* The entry report puts four spaces and PASS/FAIL in front of each way in, which is what
   separates those lines from the asset report's two. */
const MARK = /^ {4}(PASS|FAIL) {2}/;
function entryLines(out) {
  return out.split('\n').filter((l) => MARK.test(l)).map((l) => l.replace(MARK, '').trim());
}
function entryDetail(out, line) {
  const lines = out.split('\n');
  const i = lines.findIndex((l) => MARK.test(l) && l.replace(MARK, '').trim() === line);
  return i >= 0 ? (lines[i + 1] || '').trim() : '';
}
function summaryLine(out) {
  return (out.split('\n').find((l) => /ways into a pack game/.test(l)) || '').trim();
}

/* LAUNCH_SOURCES cut down to the one spelling the check had before it was widened — the
   narrowing this test is here to catch. Applied to a copy and parsed before use, so a
   mutation that produced a broken file is reported as a mutation, not as a verdict. */
function narrowTool(source) {
  const start = source.indexOf('const LAUNCH_SOURCES = [');
  if (start < 0) throw new Error('LAUNCH_SOURCES is not in check-live-assets.js any more');
  const end = source.indexOf('\n];', start);
  if (end < 0) throw new Error('the end of the LAUNCH_SOURCES array was not found');
  const one = 'const LAUNCH_SOURCES = [\n' +
    '  /<a\\b[^>]*\\bhref\\s*=\\s*["\']([^"\']+)["\']/gi\n];';
  return source.slice(0, start) + one + source.slice(end + 3);
}

console.log('entry points of check-live-assets.js — one launcher per mechanism, ' +
  CASES.length + ' of them\n');

/* ---------- build the three fixtures ---------- */
const toolSource = fs.readFileSync(TOOL, 'utf8');
let narrowedSource = null;
try {
  narrowedSource = narrowTool(toolSource);
} catch (err) {
  checkHarness('LAUNCH_SOURCES can be narrowed for the mutation case', false, String(err.message));
}
if (narrowedSource) {
  let parseError = null;
  try {
    new vm.Script(narrowedSource);
  } catch (err) {
    parseError = String(err && err.message);
  }
  checkHarness('the mutated tool is still valid JavaScript', parseError === null, parseError || '');
  checkHarness('the mutated tool is not the tool that ships', narrowedSource !== toolSource,
    'narrowTool returned the source unchanged');
}

const trees = [];
try {
  const brokenRoot = buildTree('broken', toolSource, (c) => c.broken);
  const fixedRoot = buildTree('fixed', toolSource, () => BUILD_OK);
  const mutatedRoot = narrowedSource
    ? buildTree('mutated', narrowedSource, (c) => c.broken)
    : null;
  trees.push(brokenRoot, fixedRoot);
  if (mutatedRoot) trees.push(mutatedRoot);

  check('the tool under test is the file in tools/, byte for byte',
    fs.readFileSync(path.join(brokenRoot, 'tools', 'check-live-assets.js')).equals(
      Buffer.from(toolSource)),
    'the fixture copy differs from tools/check-live-assets.js');

  const broken = await serveTree(brokenRoot);
  const fixed = await serveTree(fixedRoot);
  const mutated = mutatedRoot ? await serveTree(mutatedRoot) : null;

  try {
    /* ---------- every mechanism, pointed at a build with no guard ---------- */
    console.log('\n=== every way in, pointed at an unguarded build ===');
    const brokenRun = await runTool(brokenRoot, broken.base);
    const brokenEntries = entryLines(brokenRun.out);

    check('the run fails', brokenRun.code === 1, 'exit ' + brokenRun.code);
    for (const c of CASES) {
      check(c.mechanism + ': ' + c.verdict + ' ' + c.file + ' -> ' + c.broken + ' — ' + c.shows,
        brokenRun.out.includes(c.verdict + '  ' + c.file + ' -> ' + c.broken),
        'no such line in the entry report');
    }

    const expectedBroken = CASES.map((c) => c.file + ' -> ' + c.broken).sort();
    const extra = brokenEntries.filter((n) => !expectedBroken.includes(n));
    const missing = expectedBroken.filter((n) => !brokenEntries.includes(n));
    check('nothing else is reported and nothing is missed — ' + CASES.length + ' entries, exactly',
      extra.length === 0 && missing.length === 0 && brokenEntries.length === CASES.length,
      'not in the fixture: [' + extra.join(', ') + '] not reported: [' + missing.join(', ') + ']');

    const numFail = CASES.filter((c) => c.verdict === 'FAIL').length;
    check('the summary counts ' + numFail + ' unguarded of ' + CASES.length,
      brokenRun.out.includes(numFail + ' of ' + CASES.length +
        ' ways into a pack game are unguarded'),
      summaryLine(brokenRun.out) || 'no summary line');

    check('a page that announces no pack is never reported, even when a window opens it',
      !brokenRun.out.includes('shell-nopack'),
      'the not-a-build page was given a verdict');

    check('the seven asset checks and three workers still pass, so the entry points alone fail the run',
      brokenRun.out.includes('all 7 assets are served as real files') &&
      !/^ {2}FAIL/m.test(brokenRun.out),
      'something outside the entry points failed, which would hide the entry verdicts');

    const workerLine = 'location-replace.html -> ' + BUILD_WORKERBAD;
    check('the half-guarded build is failed for its worker, not for its page',
      entryDetail(brokenRun.out, workerLine).includes('does not import it'),
      'detail was ' + JSON.stringify(entryDetail(brokenRun.out, workerLine)));

    const workerOkLine = 'index.html -> ' + BUILD_OK;
    check('a guarded shell is named with the worker that proves it',
      entryDetail(brokenRun.out, workerOkLine).includes('/shell-ok/sw.js imports the guard'),
      'detail was ' + JSON.stringify(entryDetail(brokenRun.out, workerOkLine)));

    const noWorkerLine = 'markup-iframe.html -> ' + BUILD_NOWORKER;
    check('a guarded shell with no worker is a pass, not a missing guard',
      entryDetail(brokenRun.out, noWorkerLine).includes('registers no worker'),
      'detail was ' + JSON.stringify(entryDetail(brokenRun.out, noWorkerLine)));

    /* ---------- the same mechanisms, pointed at the guarded shell ---------- */
    console.log('\n=== the same ways in, pointed at the guarded shell ===');
    const fixedRun = await runTool(fixedRoot, fixed.base);
    const fixedEntries = entryLines(fixedRun.out);
    const expectedFixed = CASES.map((c) => c.file + ' -> ' + BUILD_OK).sort();

    check('the run passes', fixedRun.code === 0, 'exit ' + fixedRun.code);
    check('every launcher is still found — ' + CASES.length + ' entries, all of them guarded',
      fixedRun.out.includes('all ' + CASES.length + ' ways into a pack game are guarded'),
      summaryLine(fixedRun.out) || 'no summary line');
    check('and they are the same launchers, none dropped',
      fixedEntries.slice().sort().join('|') === expectedFixed.join('|'),
      '[' + fixedEntries.slice().sort().join(', ') + ']');

    /* ---------- LAUNCH_SOURCES narrowed back to one pattern ---------- */
    if (mutated) {
      console.log('\n=== the same fixture with LAUNCH_SOURCES narrowed to <a href> ===');
      const mutatedRun = await runTool(mutatedRoot, mutated.base);
      const mutatedEntries = entryLines(mutatedRun.out);

      check('narrowing the list still looks like a pass — which is why this test exists',
        mutatedRun.code === 0 && mutatedRun.out.includes('all 1 ways into a pack game are guarded'),
        'exit ' + mutatedRun.code + ', ' + (summaryLine(mutatedRun.out) || 'no summary line'));
      check('the narrowed run reports the one launcher it can still see, and no others',
        mutatedEntries.length === 1 && mutatedEntries[0] === 'index.html -> ' + BUILD_OK,
        '[' + mutatedEntries.join(', ') + ']');
      check('so the entry-set assertion is what catches a narrowed list, not the exit code',
        mutatedEntries.length !== CASES.length,
        'the narrowed run somehow reported all ' + CASES.length + ' ways in');
    }
  } finally {
    broken.close();
    fixed.close();
    if (mutated) mutated.close();
  }
} finally {
  if (KEEP) {
    console.log('\nfixtures left in place:\n  ' + trees.join('\n  '));
  } else {
    for (const root of trees) fs.rmSync(root, { recursive: true, force: true });
  }
}

const sawEveryWayIn = failures > harnessFailures;
console.log('\n' + (failures
  ? failures + ' check(s) FAILED — ' + (sawEveryWayIn
    ? 'the entry-point check is not seeing every way into a pack game'
    : 'the mutation case could not run, so the pattern list is unverified here '
      + '(every mechanism fixture case passed)')
  : 'all checks passed — every way into a pack game is seen and judged'));
process.exitCode = failures ? 1 : 0;
