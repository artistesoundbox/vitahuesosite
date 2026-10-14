/*
 * test-launch-sources.mjs — can the entry-point check still see every way into a pack game?
 *   (node tools/test-launch-sources.mjs [--keep])
 *
 * WHY THIS EXISTS
 * check-live-assets.js finishes by asking, for every launcher page in the checkout, what
 * that page opens and whether the build it opens carries the pack guard. That answer is only
 * as good as the two lists that decide what counts as "this page points at that page" —
 * LAUNCH_SOURCES for the spellings that carry the target in quotes, and LAUNCH_EXPRESSIONS
 * for the sites whose target has to be computed — and either list is easy to narrow by
 * accident, because narrowing one does not fail, it PASSES: a way in the lists cannot see is
 * a way in that is never checked, and the run still ends at 0. Silent under-reporting is the
 * one failure mode a guard check must not have, so the lists are tested rather than assumed.
 *
 * HOW
 * One fixture launcher page per mechanism, each reaching its build by exactly ONE mechanism,
 * so the verdict on that page is attributable to that mechanism alone. A mechanism the check
 * cannot see is a launcher it says nothing about, which is why every case asserts the entry
 * line itself: there is no such thing as a quiet failure here. The fixture is built twice —
 * every launcher pointed at an unguarded build (the run must fail, and name every launcher),
 * and every launcher pointed at the guarded shell (the run must pass, which is also what
 * keeps this test from proving only that the tool can say no) — and a third time with both
 * lists cut down to a single `<a href>` markup pattern, which has to come out looking like a
 * PASS: one guarded way in, nothing else reported. That mutation run is the regression this
 * test exists to catch, and it is also what shows the exact-entry-set assertion has teeth: if
 * narrowing the lists ever stops looking like a pass, the mutation case says so before the
 * fixture cases can be blamed.
 *
 * A case whose target only the browser could know — a URL computed from `location`, say —
 * asserts the opposite: no entry at all, in either tree, and no target invented for it.
 * Guessing there would fail a deploy over a page the launcher never opens, so no verdict is
 * the correct answer. It is no longer invisible, though: the tool names such a site as one it
 * could not read — a NOTE, never a PASS or a FAIL, and never a change to the exit code —
 * because "no under-reading found" and "no under-reading looked for" otherwise read alike in
 * a log. Two cases pin that trace from both sides: one unresolved navigation that must be
 * named, and one unresolved property site holding no path that must not be, so the trace
 * stays short enough to be worth reading.
 *
 * The fixture is rebuilt from scratch on every run, so it cannot drift away from this file.
 * The tool under test is copied into the fixture rather than re-implemented: the bytes that
 * run are the bytes that ship.
 *
 * NOT COVERED, deliberately: a target computed from something this side cannot know — a
 * property read (`f.src`), a function defined in another file, a method call, a URL built
 * from `location` — is left alone rather than guessed at, and named in the report only when
 * it sits at a site that is going somewhere or builds a path out of literals (the two cases
 * above); chains through a non-root
 * intermediate page; and launchers published but absent from the checkout, which this side of
 * the deploy cannot list at all.
 *
 * WHAT IT PINS: mechanisms, not patterns. Several spellings are matched by more than one
 * pattern, and since the computed-target stage reads the same literal argument sites as the
 * quoted-literal stage, most single patterns are redundant on their own now. Verified by a
 * sweep, not assumed: dropping each of the ten LAUNCH_SOURCES patterns in turn fails this
 * test for only three of them (the markup pattern, and the two meta-refresh attribute
 * orders), emptying LAUNCH_EXPRESSIONS alone fails seventeen checks — naming each of the six
 * computed-mechanism cases one by one, plus the seven that pin the trace, since a list that
 * is not there cannot name what it could not read — and emptying both lists fails thirty-seven.
 * That is the intended shape: simplifying either list stays free, and a mechanism that stops
 * being seen fails here.
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

/* A second origin, started before the fixture is written because one case points at it. Its
   address goes in here; see serveElsewhere(). */
let ELSEWHERE = '';

/* One case per way a page can open another page. `broken` is where that launcher points
   in the broken fixture and the verdict the check must reach there; `verdict` FAIL means
   that build carries no guard, so the launcher is the thing to change. Every case also
   exists to keep its mechanism on the list: drop the pattern that finds it and the entry
   disappears, which the exact-set assertion below turns into a failure.

   A case with `broken: null` opens nothing this check can name, and `trace` says which half
   of the unread behaviour it pins: true when the site must be named in the report as one the
   check could not read, false when even that must stay quiet, so the trace cannot grow into
   noise that hides the one line worth reading. */
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
  },
  /* ---- the ways in that used to be invisible: the page computes its target instead of
     writing it down. Each of these reached a build before this change and the check said
     nothing about it, which is the failure mode the whole entry stage exists to prevent. ---- */
  {
    file: 'computed-concat.html', mechanism: 'a target joined from a constant and a literal',
    broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'a build URL assembled from parts, which no quoted-literal pattern can read',
    body: (t) => {
      const parts = t.split('/');
      return `<script>
const dir = '${parts[0]}';
const file = '${parts[1]}';
frame.src = dir + '/' + file;
</script>`;
    }
  },
  {
    file: 'computed-template.html', mechanism: 'a template literal holding the path',
    broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'the modern spelling of the same join',
    body: (t) => {
      const parts = t.split('/');
      return '<script>\n' +
        `const dir = '${parts[0]}';\n` +
        'window.location.href = `\u0024{dir}/' + parts[1] + '`;\n' +
        '</script>';
    }
  },
  {
    file: 'computed-param.html', mechanism: 'a target handed to a function and opened there',
    broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'the build URL passed as an argument, so only the call sites name the page',
    body: (t) => `<script>
const target = '${t}';
function play(u) {
  window.open(u, 'game');
}
play(target);
</script>`
  },
  {
    file: 'computed-return.html', mechanism: 'a function that returns the target',
    broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'the path built inside a function and handed to a navigation call',
    body: (t) => `<script>
function buildHref(dir) { return dir + '/index.html'; }
location.assign(buildHref('${t.split('/')[0]}'));
</script>`
  },
  {
    file: 'computed-branch-guarded.html', mechanism: 'a conditional whose other branch is not a build',
    broken: BUILD_BAD, verdict: 'FAIL',
    shows: 'branch A is the build and branch B is a page, so branch A is the way in',
    body: (t) => `<script>
const pick = USE_DAILY ? '${t}' : '${NOT_A_BUILD}';
frame.src = pick;
</script>`
  },
  {
    file: 'computed-branch-plain.html', mechanism: 'a conditional whose other branch is the build',
    broken: BUILD_OK, verdict: 'PASS',
    shows: 'the same conditional the other way round, so the second branch is read too',
    body: (t) => `<script>
const pick = USE_DAILY ? '${NOT_A_BUILD}' : '${t}';
frame.src = pick;
</script>`
  },
  {
    file: 'computed-unknown.html', mechanism: 'a target only the browser can know',
    broken: null, verdict: null, trace: true,
    shows: 'the racegame.html shape: a URL computed from location, which is named as unread rather than guessed',
    body: () => `<script>
function modeHref() { return location.pathname + (DAILY ? '?daily' : ''); }
location.href = modeHref();
</script>`
  },
  {
    file: 'unread-quiet.html', mechanism: 'an unresolved src that holds no path',
    broken: null, verdict: null, trace: false,
    shows: 'the other side of the trace: a video src joined onto a literal with a scheme, and a '
      + 'property read with no path in it \u2014 neither is judged, and neither is named',
    body: () => `<script>
var player = document.getElementById('p');
var mp4 = document.getElementById('m');
player.src = 'https://www.youtube-nocookie.com/embed/' + v.id;
mp4.src = f.src;
</script>`
  },
  {
    file: 'unread-many.html', mechanism: 'more unreadable sites than one page may name',
    broken: null, verdict: null, trace: true,
    shows: 'the cap: nine unreadable navigations are named up to the limit and the rest are '
      + 'counted \u2014 a trace that silently stopped at eight would be the very failure it exists to fix',
    body: () => {
      const lines = [];
      for (let i = 1; i <= 9; i++) lines.push('location.href = href' + i + '();');
      return '<script>\n' + lines.join('\n') + '\n</script>';
    }
  },
  /* ---- the third silence: a launcher whose target is not there. The target resolves, so no
     expression can be traced, and the fetch answers 404 \u2014 which used to be dropped with
     every other target that is not a pack build. `dead` is where that target sits: 'named'
     when it belongs to this site, 'quiet' when the same 404 comes from another deployment. ---- */
  {
    file: 'dead-onsite.html', mechanism: 'a link to a page this site does not serve',
    broken: null, verdict: null, dead: 'named',
    shows: 'a resolved target under the site\u2019s own base that is not there, which no verdict '
      + 'rule can speak about \u2014 unnamed, this launcher reads exactly like a working one',
    body: () => '<a href="gone/index.html">Play</a>'
  },
  {
    file: 'dead-elsewhere.html', mechanism: 'a link to a page another host does not serve',
    broken: null, verdict: null, dead: 'quiet',
    shows: 'the same 404 off this site: another deployment is not what this run was pointed at, '
      + 'and naming those would bury the dead links that are this site\u2019s own',
    body: () => '<a href="' + ELSEWHERE + '/missing/index.html">Play</a>'
  },
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

/* A second origin that answers 404 to everything, as the stand-in for a launcher pointing at
   another deployment. The counter is what keeps the "left alone" assertion two-sided: the
   target was reached and then deliberately not named, rather than never read at all. */
function serveElsewhere() {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    state.hits++;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not here');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.base = 'http://127.0.0.1:' + server.address().port;
      state.close = () => server.close();
      resolve(state);
    });
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

/* A declaration whose array is cut down to one entry — the shape a narrowed tool has. */
function replaceArray(source, declaration, replacement) {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(declaration + ' is not in check-live-assets.js any more');
  const end = source.indexOf('\n];', start);
  if (end < 0) throw new Error('the end of ' + declaration + ' was not found');
  return source.slice(0, start) + replacement + source.slice(end + 3);
}

/* LAUNCH_SOURCES cut back to the one spelling the check started with, and the
   computed-target list emptied: the two of them together are what sees every way in, so
   narrowing only one would leave the tool seeing most of the fixture and this test looking
   broken instead of showing the tool go blind. Applied to a copy and parsed before use, so
   a mutation that produced a broken file is reported as a mutation, not as a verdict. */
function narrowTool(source) {
  const one = 'const LAUNCH_SOURCES = [\n' +
    '  /<a\\b[^>]*\\bhref\\s*=\\s*["\']([^"\']+)["\']/gi\n];';
  return replaceArray(replaceArray(source, 'const LAUNCH_SOURCES = [', one),
    'const LAUNCH_EXPRESSIONS = [', 'const LAUNCH_EXPRESSIONS = [\n];');
}

console.log('entry points of check-live-assets.js — one launcher per mechanism, ' +
  CASES.length + ' of them\n');

/* ---------- build the three fixtures ---------- */
const toolSource = fs.readFileSync(TOOL, 'utf8');
let narrowedSource = null;
try {
  narrowedSource = narrowTool(toolSource);
} catch (err) {
  checkHarness('both spelling lists can be narrowed for the mutation case', false, String(err.message));
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
  checkHarness('the mutation emptied the computed-target list as well',
    narrowedSource.indexOf('const LAUNCH_EXPRESSIONS = [\n];') >= 0,
    'the mutation left entries in LAUNCH_EXPRESSIONS');
}

/* Started before the fixture is written, because one launcher page points at it, and closed
   with the fixture trees below. */
const elsewhere = await serveElsewhere();
ELSEWHERE = elsewhere.base;

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
    /* What each run does with the other origin, counted at the origin: the assertions below
       need to know it was reached, not only that nothing was said about it. */
    const elsewhereHits = { broken: 0, fixed: 0, mutated: 0 };
    let seen = elsewhere.hits;
    const brokenRun = await runTool(brokenRoot, broken.base);
    elsewhereHits.broken = elsewhere.hits - seen;
    const brokenEntries = entryLines(brokenRun.out);

    check('the run fails', brokenRun.code === 1, 'exit ' + brokenRun.code);
    /* One case has no way in to assert: its target cannot be known without running the
       page, which is the whole point of it. */
    const opensSomething = CASES.filter((c) => c.broken);
    for (const c of opensSomething) {
      check(c.mechanism + ': ' + c.verdict + ' ' + c.file + ' -> ' + c.broken + ' — ' + c.shows,
        brokenRun.out.includes(c.verdict + '  ' + c.file + ' -> ' + c.broken),
        'no such line in the entry report');
    }

    const expectedBroken = opensSomething.map((c) => c.file + ' -> ' + c.broken).sort();
    const extra = brokenEntries.filter((n) => !expectedBroken.includes(n));
    const missing = expectedBroken.filter((n) => !brokenEntries.includes(n));
    check('nothing else is reported and nothing is missed — ' + expectedBroken.length +
      ' entries, exactly',
      extra.length === 0 && missing.length === 0 &&
        brokenEntries.length === expectedBroken.length,
      'not in the fixture: [' + extra.join(', ') + '] not reported: [' + missing.join(', ') + ']');

    const numFail = CASES.filter((c) => c.verdict === 'FAIL').length;
    check('the summary counts ' + numFail + ' unguarded of ' + expectedBroken.length,
      brokenRun.out.includes(numFail + ' of ' + expectedBroken.length +
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
    seen = elsewhere.hits;
    const fixedRun = await runTool(fixedRoot, fixed.base);
    elsewhereHits.fixed = elsewhere.hits - seen;
    const fixedEntries = entryLines(fixedRun.out);
    const expectedFixed = opensSomething.map((c) => c.file + ' -> ' + BUILD_OK).sort();

    check('the run passes', fixedRun.code === 0, 'exit ' + fixedRun.code);
    check('every launcher that opens something is still found — ' + opensSomething.length +
      ' entries, all of them guarded',
      fixedRun.out.includes('all ' + opensSomething.length + ' ways into a pack game are guarded'),
      summaryLine(fixedRun.out) || 'no summary line');
    check('and they are the same launchers, none dropped',
      fixedEntries.slice().sort().join('|') === expectedFixed.join('|'),
      '[' + fixedEntries.slice().sort().join(', ') + ']');

    /* The negative control, in the shape the trace gives it. A target that only the browser
       could know is never guessed at and never given a verdict — and it is no longer invisible
       either, so the assertions are two-sided: no entry and no invented target, and, for the
       sites that are going somewhere, a NOTE naming the launcher and the expression. */
    const unjudged = CASES.filter((c) => !c.broken && !c.dead).map((c) => c.file);
    const traced = CASES.filter((c) => !c.broken && c.trace === true).map((c) => c.file);
    const quiet = CASES.filter((c) => !c.broken && c.trace === false).map((c) => c.file);
    const deadNamed = CASES.filter((c) => c.dead === 'named').map((c) => c.file);
    const deadQuiet = CASES.filter((c) => c.dead === 'quiet').map((c) => c.file);
    const NOTE = (f) => '    NOTE  ' + f + ' \u2014 ';

    check('a target that cannot be known is never given a verdict, in either tree — ' +
      unjudged.join(', '),
      unjudged.length > 0 && unjudged.every((f) =>
        !brokenRun.out.includes(f + ' ->') && !fixedRun.out.includes(f + ' ->')),
      'a target was invented for: ' + unjudged.filter((f) =>
        brokenRun.out.includes(f + ' ->') || fixedRun.out.includes(f + ' ->')).join(', '));

    check('an unreadable launch site is named rather than passed over — ' + traced.join(', '),
      traced.length > 0 && traced.every((f) =>
        brokenRun.out.includes(NOTE(f)) && fixedRun.out.includes(NOTE(f))),
      'no NOTE for: ' + traced.filter((f) =>
        !brokenRun.out.includes(NOTE(f)) || !fixedRun.out.includes(NOTE(f))).join(', '));

    check('and the NOTE names the expression, so the line can be acted on',
      brokenRun.out.includes('a navigation: modeHref()') &&
        fixedRun.out.includes('a navigation: modeHref()'),
      'the expression is not in the report');

    check('the trace says how many sites each page has — 1 on one page, 9 on the other',
      brokenRun.out.includes('NOTE  computed-unknown.html — 1 launch site this check cannot read') &&
        fixedRun.out.includes('NOTE  computed-unknown.html — 1 launch site this check cannot read') &&
        brokenRun.out.includes('NOTE  unread-many.html — 9 launch sites this check cannot read') &&
        fixedRun.out.includes('NOTE  unread-many.html — 9 launch sites this check cannot read'),
      [brokenRun, fixedRun].map((r) =>
        (r.out.split('\n').find((l) => /NOTE .*unread-many/.test(l)) || 'no NOTE for unread-many.html').trim())
        .join(' / '));

    const namedNine = (out) =>
      out.split('\n').filter((l) => /^ {12}a navigation: href\d+\(\)$/.test(l)).length;
    check('and the cap names ' + 8 + ' of those 9, counting the rest rather than dropping them',
      namedNine(brokenRun.out) === 8 && namedNine(fixedRun.out) === 8 &&
        brokenRun.out.includes('and 1 more like them') && fixedRun.out.includes('and 1 more like them'),
      namedNine(brokenRun.out) + ' named, ' +
        (brokenRun.out.includes('and 1 more like them') ? 'the ninth counted' : 'the ninth MISSING'));

    check('and the trace adds up to the pages it names, not to the sites it lists',
      brokenRun.out.includes('2 launcher pages carry a launch site this check cannot read') &&
        fixedRun.out.includes('2 launcher pages carry a launch site this check cannot read'),
      [brokenRun, fixedRun].map((r) =>
        (r.out.split('\n').find((l) => /carry a launch site/.test(l)) || 'no trace summary').trim())
        .join(' / '));

    check('a passing run still says what it could not read, and the NOTE is not what fails a run',
      fixedRun.code === 0 && traced.length > 0 &&
        /carry a launch site this check cannot read/.test(fixedRun.out),
      'exit ' + fixedRun.code + ': ' +
        (fixedRun.out.split('\n').find((l) => /carry a launch site/.test(l)) || 'no trace').trim());

    check('and that passing run closes by saying what the trace means for it',
      fixedRun.out.includes('Nothing above is a failure') &&
        fixedRun.out.includes('that way in is unguarded and this report could not have said so.'),
      'the closing note is missing from the clean run with an unreadable site in it');

    check('a property site with no path in it is not named even as unreadable — ' + quiet.join(', '),
      quiet.length > 0 && quiet.every((f) =>
        !brokenRun.out.includes(f) && !fixedRun.out.includes(f)),
      'named anyway: ' + quiet.filter((f) =>
        brokenRun.out.includes(f) || fixedRun.out.includes(f)).join(', '));

    /* The third silence: a target this site does not serve. There is no build to judge, so no
       verdict can carry it — which makes the note the only thing between that launcher and
       looking exactly like a working one. Pinned from both sides, like the trace: named under
       this site's own base, left alone when the same 404 comes from elsewhere. */
    check('a target this site does not serve is named, and never given a verdict — ' +
      deadNamed.join(', '),
      deadNamed.length > 0 && deadNamed.every((f) =>
        brokenRun.out.includes(NOTE(f)) && fixedRun.out.includes(NOTE(f)) &&
        !brokenRun.out.includes(f + ' ->') && !fixedRun.out.includes(f + ' ->')),
      deadNamed.filter((f) =>
        !brokenRun.out.includes(NOTE(f)) || !fixedRun.out.includes(NOTE(f)))
        .map((f) => f + ' NOT named')
        .concat(deadNamed.filter((f) => brokenRun.out.includes(f + ' ->')).map((f) => f + ' given a verdict'))
        .join(', ') || 'no case in the fixture has a target this site does not serve');

    check('and the note counts that page\u2019s targets and names the path and what came back',
      brokenRun.out.includes('NOTE  dead-onsite.html — 1 target this site does not serve') &&
        fixedRun.out.includes('NOTE  dead-onsite.html — 1 target this site does not serve') &&
        brokenRun.out.includes('gone/index.html — not on the site (404)') &&
        fixedRun.out.includes('gone/index.html — not on the site (404)'),
      [brokenRun, fixedRun].map((r) => (r.out.split('\n').find((l) => /dead-onsite/.test(l)) ||
        'no NOTE for dead-onsite.html').trim()).join(' / '));

    check('and it is counted in pages, and said to be no verdict either way',
      brokenRun.out.includes('1 launcher points at a page this site does not serve — ' +
        'named above, no verdict either way') &&
        fixedRun.out.includes('1 launcher points at a page this site does not serve — ' +
          'named above, no verdict either way'),
      (brokenRun.out.split('\n').find((l) => /does not serve —/.test(l)) || 'no such line').trim());

    check('a dead target off this site is left alone — ' + deadQuiet.join(', '),
      deadQuiet.length > 0 && deadQuiet.every((f) =>
        !brokenRun.out.includes(f) && !fixedRun.out.includes(f)),
      'named anyway: ' + deadQuiet.filter((f) =>
        brokenRun.out.includes(f) || fixedRun.out.includes(f)).join(', '));

    /* The count is asserted for the two runs of the tool that ships; the narrowed run's own
       count is taken later, in the mutation section, and is not what this pins. */
    const deadHits = [elsewhereHits.broken, elsewhereHits.fixed];
    check('and it is left alone because it is another deployment\u2019s, not because it went unread',
      deadHits.every((h) => h === 1),
      'the other origin answered ' + deadHits.join(' / ') + ' probe(s) per run, one expected');

    check('a clean run closing says what the dead target means for it, not only the unreadable site',
      fixedRun.out.includes('Nothing above is a failure') &&
        fixedRun.out.includes('and 1 launcher points at a page this site does not serve.') &&
        fixedRun.out.includes('follows that launcher gets the host\u2019s 404 page'),
      (fixedRun.out.split('\n').find((l) => /Nothing above is a failure/.test(l)) || 'no closing line')
        .trim());

    /* ---------- both spelling lists narrowed, so the tool goes blind ---------- */
    if (mutated) {
      console.log('\n=== the same fixture with LAUNCH_SOURCES narrowed to <a href> ===');
      seen = elsewhere.hits;
      const mutatedRun = await runTool(mutatedRoot, mutated.base);
      elsewhereHits.mutated = elsewhere.hits - seen;
      const mutatedEntries = entryLines(mutatedRun.out);

      checkHarness('narrowing the list still looks like a pass — which is why this test exists',
        mutatedRun.code === 0 && mutatedRun.out.includes('all 1 ways into a pack game are guarded'),
        'exit ' + mutatedRun.code + ', ' + (summaryLine(mutatedRun.out) || 'no summary line'));
      checkHarness('the narrowed run reports the one launcher it can still see, and no others',
        mutatedEntries.length === 1 && mutatedEntries[0] === 'index.html -> ' + BUILD_OK,
        '[' + mutatedEntries.join(', ') + ']');
      checkHarness('so the entry-set assertion is what catches a narrowed list, not the exit code',
        mutatedEntries.length !== CASES.length,
        'the narrowed run somehow reported all ' + CASES.length + ' ways in');
      checkHarness('the trace needs a pattern to fire at all: the narrowed tool prints the ' +
        'resolved-everything line while reporting one launcher',
        mutatedRun.out.includes('every launch site in the launcher pages resolved to a target') &&
          mutatedEntries.length === 1,
        '[' + mutatedEntries.join(', ') + '] with ' +
          (mutatedRun.out.split('\n').find((l) => /launch site/.test(l)) || 'no trace line').trim());
      checkHarness('the narrowed tool reaches the other origin too, and still says nothing about it',
        elsewhereHits.mutated === 1 && !mutatedRun.out.includes('dead-elsewhere.html'),
        'the other origin answered ' + elsewhereHits.mutated + ' probe(s)');
    }
  } finally {
    broken.close();
    fixed.close();
    if (mutated) mutated.close();
  }
} finally {
  elsewhere.close();
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
