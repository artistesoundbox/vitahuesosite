/*
 * test-pack-guard.mjs — does the stub guard in the pack workers actually hold?
 *   (node tools/test-pack-guard.mjs)
 *
 * WHY THIS EXISTS
 * seblerskers/site-sw.js and game/sw-pack.js both feed pack bytes to the engine
 * and both refuse a stub first: the 134-byte Git LFS pointer a host without
 * `lfs: true` publishes for a huge asset, or an error page from an edge that has
 * lost the object. That check is the only thing standing between a player and a
 * four-line text file being parsed as a 300 MB game, so it is tested rather than
 * assumed — including that the guarded path hands the bytes on UNCHANGED, which
 * is the part that could pass a stub test and still quietly corrupt a pack.
 *
 * The workers are loaded as they are, from disk, in a bare context with the
 * globals a service worker expects. Nothing is re-implemented here: the
 * functions under test are the ones that ship.
 *
 * NOT COVERED, deliberately: the guards as reachable through a real fetch event
 * (that needs a browser and a CDN that serves a pointer), and the shell's own
 * probe in seblerskers/index.html, which is a page not a worker. What is covered
 * is the classifier, the pass-through, and the two copies agreeing.
 *
 * exits 1 if any check fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

/* label is what the worker sets as self.PACK_GUARD_LABEL, which is what the
   shared guard prefixes its refusals with. */
const WORKERS = [
  { file: 'seblerskers/site-sw.js', label: 'seblerskers/site-sw.js', says: 'seblerskers' },
  { file: 'game/sw-pack.js', label: 'game/sw-pack.js', says: 'over the ice' }
];

const GUARD_FILE = 'pack-guard.js';

const POINTER = 'version https://git-lfs.github.com/spec/v1\n' +
  'oid sha256:' + 'c'.repeat(64) + '\nsize 561704920\n';

/* What the two labels in those PREFIX constants are - only used to show that a
   failure came out of the worker it claims to. */
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range'];

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '\n          ' + detail));
  if (!ok) failures++;
}

/* Load a worker file in a context with the globals it expects, and nothing else.
   importScripts is the one piece of the worker environment that has to be
   provided: it reads the URL off disk, resolved against the worker's own path,
   exactly as the browser resolves it against the worker's own URL. */
function loadWorker(relPath) {
  const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const sandbox = {
    self: {
      addEventListener() {},
      skipWaiting() {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      location: { origin: 'https://example.test' }
    },
    caches: {
      open: async () => cacheStub(),
      keys: async () => [],
      delete: async () => true,
      match: async () => null
    },
    fetch: async () => { throw new Error('no network in this test'); },
    console: { log() {}, info() {}, warn() {}, error() {} },
    // the host realm's web types, so the stream plumbing under test is the same
    // implementation the browser runs and cross-realm byte checks cannot arise
    Headers, Response, Request, ReadableStream, TextDecoder, TextEncoder,
    Uint8Array, ArrayBuffer, DataView, URL, URLSearchParams, setTimeout, clearTimeout
  };
  const imported = [];
  sandbox.importScripts = function () {
    for (const url of arguments) {
      const resolved = path.resolve(path.dirname(path.join(ROOT, relPath)), String(url));
      imported.push(String(url));
      vm.runInContext(fs.readFileSync(resolved, 'utf8'), sandbox, { filename: String(url) });
    }
  };
  sandbox.__imported = imported;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: relPath });
  return sandbox;
}

function cacheStub() {
  return {
    match: async () => null,
    put: async () => {},
    delete: async () => true,
    keys: async () => []
  };
}

function body(size, fill) {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = fill(i);
  return buf;
}

function packHead(size) {
  const buf = body(size, (i) => (i * 7) % 251);
  buf.set([0x47, 0x44, 0x50, 0x43], 0);   // GDPC
  return buf;
}

function textResponse(text, status = 200, headers = {}) {
  return new Response(text, {
    status,
    headers: Object.assign({ 'content-type': 'text/plain' }, headers)
  });
}

/* What a guard says about a pointer body, as {status, text}. */
async function ptrText(body, guardFn) {
  const res = await guardFn(textResponse(body, 200, { 'content-length': String(body.length) }), true);
  return { status: res.status, text: await res.text() };
}

async function readBytes(res) {
  return new Uint8Array(await res.arrayBuffer());
}

function sameBytes(a, b) {
  if (a.length !== b.length) return 'length ' + a.length + ' vs ' + b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return 'byte ' + i + ': ' + a[i] + ' vs ' + b[i];
  }
  return null;
}

for (const { file, label, says } of WORKERS) {
  console.log('\n=== ' + label + ' ===');
  const worker = loadWorker(file);
  const { guardPack, stubByLength, stubResponse, stubReason } = worker;
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');

  check(label + ': loads the one shared guard instead of carrying its own copy',
    /importScripts\(["']\.\.\/pack-guard\.js["']\)/.test(source) &&
    !/function guardPack/.test(source),
    'importScripts present: ' + /importScripts\(/.test(source) +
    ', inline guardPack still defined: ' + /function guardPack/.test(source));
  check(label + ': the guard arrived from ' + GUARD_FILE,
    worker.__imported.length === 1 && worker.__imported[0] === '../pack-guard.js',
    'imported ' + JSON.stringify(worker.__imported));
  check(label + ': the guard functions are on the worker global',
    typeof guardPack === 'function' && typeof stubByLength === 'function' &&
    typeof stubReason === 'function' && typeof stubResponse === 'function',
    'guardPack=' + typeof guardPack + ' stubByLength=' + typeof stubByLength);

  // 1. the LFS pointer, at a whole-pack URL — and the refusal says which worker
  const ptrBody = await ptrText(POINTER, guardPack);
  check(label + ': an LFS pointer at the pack URL is refused',
    ptrBody.status === 502 && /Git LFS pointer/.test(ptrBody.text),
    'status ' + ptrBody.status + ', body ' + JSON.stringify(ptrBody.text.slice(0, 80)));
  check(label + ': the refusal is prefixed with "' + says + '"',
    ptrBody.text.indexOf(says + ': ') === 0,
    'body was ' + JSON.stringify(ptrBody.text.slice(0, 60)));

  // 2. the pointer at a chunk URL — the magic cannot be checked there, so the
  //    pointer has to be caught by its own shape
  const ptrChunk = await guardPack(textResponse(POINTER, 200, { 'content-length': String(POINTER.length) }), false);
  check(label + ': an LFS pointer at a chunk URL is refused too',
    ptrChunk.status === 502 && /Git LFS pointer/.test(await ptrChunk.clone().text()),
    'status ' + ptrChunk.status);

  // 3. an HTML error page (a host that 200s its 404 page)
  const html = await guardPack(textResponse('<!DOCTYPE html><html></html>'), true);
  check(label + ': an error page is refused',
    html.status === 502 && /not a pack/.test(await html.clone().text()),
    'status ' + html.status + ', body ' + JSON.stringify((await html.clone().text()).slice(0, 80)));

  // 4. a real pack head passes through byte-for-byte
  const head = packHead(3 * 1024 * 1024);
  const passed = await guardPack(new Response(head, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(head.length) }
  }), true);
  const passedBytes = await readBytes(passed);
  const diff = sameBytes(head, passedBytes);
  check(label + ': a real pack head passes through unchanged',
    passed.status === 200 && diff === null,
    'status ' + passed.status + ', ' + (diff || 'bytes equal'));
  check(label + ': the pass-through keeps the size the engine reads',
    passed.headers.get('content-length') === String(head.length),
    'content-length ' + passed.headers.get('content-length'));

  // 5. mid-pack bytes: no magic of their own, still forwarded intact
  const mid = body(1500 * 1024, (i) => (i * 13) % 253);
  const midOut = await guardPack(new Response(mid), false);
  const midBytes = await readBytes(midOut);
  check(label + ': a chunk checks out and forwards unchanged',
    midOut.status === 200 && sameBytes(mid, midBytes) === null,
    'status ' + midOut.status + ', ' + (sameBytes(mid, midBytes) || 'bytes equal'));

  // 6. mid-pack bytes where the pack HEAD was expected
  const wrongPosition = await guardPack(new Response(mid), true);
  check(label + ': pack bytes that are not the head are refused',
    wrongPosition.status === 502 && /not a Godot pack/.test(await wrongPosition.clone().text()),
    'status ' + wrongPosition.status);

  // 7. an HTTP failure is the caller's business, not a stub to rewrite
  const missing = await guardPack(textResponse('not here', 404), true);
  check(label + ': a 404 is passed through, not relabelled',
    missing.status === 404,
    'status ' + missing.status);

  // 8. the cheap cache check
  const cachedStub = stubByLength(new Response(POINTER, { headers: { 'content-length': String(POINTER.length) } }));
  const cachedPack = stubByLength(new Response(body(8 * 1024 * 1024, () => 1), {
    headers: { 'content-length': String(8 * 1024 * 1024) }
  }));
  check(label + ': a cached 134-byte part is a stub, a cached 8 MB part is not',
    cachedStub && cachedStub.status === 502 && cachedPack === null,
    'stub=' + (cachedStub && cachedStub.status) + ' pack=' + cachedPack);

  // 9. a partial response keeps its range headers
  const ranged = await guardPack(new Response(packHead(1024), {
    status: 206,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': '1024',
      'content-range': 'bytes 0-1023/561704920'
    }
  }), true);
  check(label + ': a 206 keeps its range headers',
    ranged.status === 206 && ranged.headers.get('content-range') === 'bytes 0-1023/561704920',
    'status ' + ranged.status + ', content-range ' + ranged.headers.get('content-range'));
}

/* Both workers import the same file, so there is exactly one copy of the guard to
   drift and nothing left to compare between them — what is left to check is that
   neither of them quietly kept a copy of its own, and that one implementation
   reaches the same verdict through both. */
console.log('\n=== one guard, both workers ===');
check('the guard lives in ' + GUARD_FILE + ' and nowhere else in these two workers',
  /function guardPack/.test(fs.readFileSync(path.join(ROOT, GUARD_FILE), 'utf8')) &&
  !WORKERS.some((w) => /function guardPack|function stubReason|function stubByLength/
    .test(fs.readFileSync(path.join(ROOT, w.file), 'utf8'))),
  'a worker still defines one of the guard functions inline');

const loaded = WORKERS.map((w) => ({ label: w.label, ctx: loadWorker(w.file) }));
const consts = loaded.map(({ ctx }) => vm.runInContext(
  'globalThis.__guard = { POINTER_PREFIX: POINTER_PREFIX, PACK_MAGIC: PACK_MAGIC,' +
  ' STUB_CEILING: STUB_CEILING }; globalThis.__guard', ctx));
for (const name of Object.keys(consts[0])) {
  check('both workers use the same ' + name,
    consts[0][name] === consts[1][name],
    consts[0][name] + ' vs ' + consts[1][name]);
}

const CASES = [
  { name: 'an LFS pointer at a pack URL', text: POINTER, needMagic: true },
  { name: 'an LFS pointer at a chunk URL', text: POINTER, needMagic: false },
  { name: 'an error page', text: '<!DOCTYPE html><html></html>', needMagic: true },
  { name: 'a real pack head', bytes: packHead(1 << 20), needMagic: true },
  { name: 'mid-pack bytes', bytes: body(1 << 20, (i) => (i * 5) % 251), needMagic: false },
  { name: 'mid-pack bytes where a head was expected', bytes: body(1 << 20, (i) => (i * 5) % 251), needMagic: true }
];

for (const c of CASES) {
  const verdicts = [];
  for (const { ctx } of loaded) {
    const res = await ctx.guardPack(new Response(c.bytes || c.text), c.needMagic);
    verdicts.push(res.status);
  }
  check('both workers reach the same verdict on ' + c.name + ' (HTTP ' + verdicts.join(' / ') + ')',
    verdicts[0] === verdicts[1], 'they disagree: ' + verdicts.join(' vs '));
}

/* The shell is a page, not a worker, so its probe cannot be loaded on its own —
   but trueSizeOnce() is the thing that decides whether a player is told they have
   been handed a pointer, so it is lifted out of the shipped HTML by brace
   counting and run against a host that answers with a stub. */
console.log('\n=== seblerskers/index.html: the shell probe ===');
const shellSource = fs.readFileSync(path.join(ROOT, 'seblerskers/index.html'), 'utf8');
const probeSource = extractFunction(shellSource, 'trueSizeOnce');
check('trueSizeOnce() is found in the shipped shell', !!probeSource,
  'the function the fallback paths call was not found by name');

async function runShellProbe(bytes, headers) {
  const sandbox = {
    CDN_BASE: 'https://cdn.test/seblerskers/index.pck',
    fetch: async () => new Response(bytes, { status: 200, headers }),
    TextDecoder, Response, Headers, Number, Promise, Error, Date, Math, JSON, String,
    Uint8Array, ArrayBuffer,
    console: { log() {}, info() {}, warn() {}, error() {} }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(probeSource + '\nglobalThis.__probe = trueSizeOnce;', sandbox);
  return sandbox.__probe();
}

const RANGE_OK = { 'content-range': 'bytes 0-63/561704920' };

const pointerProbe = await runShellProbe(POINTER, RANGE_OK).then(
  () => ({ threw: false }), (err) => ({ threw: true, message: String(err && err.message) }));
check('the shell names the LFS pointer when the pack URL answers with one',
  pointerProbe.threw && /Git LFS pointer/.test(pointerProbe.message),
  pointerProbe.threw ? 'message was ' + JSON.stringify(pointerProbe.message)
    : 'it did not reject at all');

const pageProbe = await runShellProbe('<!DOCTYPE html>' + 'x'.repeat(200), RANGE_OK).then(
  () => ({ threw: false }), (err) => ({ threw: true, message: String(err && err.message) }));
check('the shell still refuses an error page',
  pageProbe.threw && /not a Godot pack/.test(pageProbe.message),
  pageProbe.threw ? 'message was ' + JSON.stringify(pageProbe.message) : 'it did not reject');

const realProbe = await runShellProbe(packHead(64), RANGE_OK).then(
  (head) => ({ ok: true, head }), (err) => ({ ok: false, message: String(err && err.message) }));
check('a real pack head still sizes, so the guard cannot block a good load',
  realProbe.ok && realProbe.head.size === 561704920 && realProbe.head.ranges === 'bytes',
  JSON.stringify(realProbe));

console.log('\n' + (failures ? failures + ' check(s) FAILED' : 'all checks passed'));
process.exitCode = failures ? 1 : 0;

/* The one function of the shell this test needs, taken by brace counting so the
   body can contain braces of its own (every .then(function () { ... })). */
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}
