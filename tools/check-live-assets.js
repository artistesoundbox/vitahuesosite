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
 * and a target does not have to be written down either: a constant, a join of parts, a
 * template literal, a function's parameter, or a value a function returns are resolved
 * too (see TARGETS A PAGE COMPUTES), and only a target that cannot be known from the
 * page's own text is left alone. Every target that turns out to be a pack build must load
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
 *
 * Two lists decide what counts as a way in: LAUNCH_SOURCES, below, for targets the page
 * writes down, and LAUNCH_EXPRESSIONS for targets it computes. Both feed the same filter
 * and the same verdict, so a target written down and the same target computed are one way
 * in and produce one entry.
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
/* ---------------------------------------------------------------------------
 * TARGETS A PAGE COMPUTES
 *
 * The list above reads a target out of quotes. A launcher does not have to write one
 * there: it can keep the path in a constant, join it from parts, hand it to a function
 * and open the parameter, or return it from a function. Those are ways in that used to be
 * invisible, and what follows reads them without running the page — a reader for one small
 * subset of JavaScript:
 *
 *   'literal'  "literal"  `template`  `with ${parts}`
 *   a + b + '/index.html'      (a name, or a part, that was itself resolved)
 *   cond ? x : y               (both branches are possible ways in)
 *   x || fallback              (both are possible)
 *   fn(args)                   (for fn defined in THIS page: its parameters take the values
 *                               the call sites pass, and its value is whatever its return
 *                               expressions come to)
 *
 * EVERYTHING ELSE IS UNKNOWN, and an unknown expression yields no target at all. That
 * asymmetry is the point: an unresolved expression costs a way in this check cannot see,
 * while a guessed one costs a deploy failed over a page the launcher never opens. So
 * nothing here evaluates a property read, a call to a function defined in another file, a
 * method, arithmetic, or a URL built from location — `modeHref(!DAILY_ON)` in racegame.html
 * returns `location.pathname + q` and stays invisible, which is right: that page reloads
 * itself and opens no build.
 *
 * Parameters are bound per function from that function's call sites in the same page, so
 * `function play(u) { open(u) } play('/game/index.html')` resolves, while a site inside a
 * nested function sees only that inner function's parameters. A name assigned in two
 * branches carries both values; a name with more branches than MAX_VALUES_PER_NAME keeps
 * the first ones, which is the only place this reader stops early.
 */
const LAUNCH_EXPRESSIONS = [
  /(?:GAME_URL|GAME_PATH|GAME_SRC|GAME_HREF)\s*=\s*/g,
  /\b(?:window|document|top|parent|self)\s*\.\s*location\s*(?:\.\s*(?:href|assign|replace)\s*)?(?:\(|=)\s*/g,
  /\blocation\s*(?:\.\s*(?:href|assign|replace)\s*)?(?:\(|=)\s*/g,
  /\b(?:window|self|top|parent)\s*\.\s*open\s*\(\s*/g,
  /(?<![.\w$])open\s*\(\s*/g,
  /\.\s*(?:src|href|action)\s*=\s*/g,
  /setAttribute\s*\(\s*['"](?:src|href|action)['"]\s*,\s*/g
];

const MAX_VALUES_PER_NAME = 8;   // branches one name may carry before the rest are dropped
const MAX_JOIN = 24;             // combinations one join may produce before the rest go
const RESOLVE_PASSES = 4;        // passes over the assignments, so a chain of names resolves
const MAX_EXPR = 2048;           // longer than any target a launcher writes
const MAX_CALL_DEPTH = 3;        // fn() calling fn() calling fn() is as far as this reads

/* The expression starting at i: it ends at a `;`, `,` or closing bracket at depth 0, or at
   a newline that arrives once the expression already looks finished — so `var url = 'x'` on
   a line of its own stops there, and a line ending in `+` keeps reading. Quotes are
   followed, so punctuation inside a string is just text. */
function readExpression(text, i) {
  let depth = 0;
  let quote = null;
  let out = '';
  for (let j = i; j < text.length && out.length < MAX_EXPR; j++) {
    const ch = text[j];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += text[j + 1] || ''; j++; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (!depth) break;
      depth--;
    } else if (!depth && (ch === ';' || ch === ',')) break;
    else if (ch === '\n' && out.trim() && !/[+\-*/%|&?:.,([{<>=]$/.test(out.trim())) break;
    out += ch;
  }
  return { expr: out.trim(), end: i + out.length };
}

/* The index of the bracket that closes the one at `open`, quotes followed. */
function matchingClose(text, open) {
  const opener = text[open];
  const closer = opener === '(' ? ')' : '}';
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === opener) depth++;
    else if (ch === closer) { depth--; if (!depth) return i; }
  }
  return -1;
}

/* Split at depth 0, outside quotes: `+` joins and argument lists both need this. */
function splitTop(text, seps) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote && quote !== '`') {
      cur += ch;
      if (ch === '\\') { cur += text[i + 1] || ''; i++; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (!depth) {
      const sep = seps.find(function (s) { return text.startsWith(s, i); });
      if (sep) { parts.push(cur); cur = ''; i += sep.length - 1; continue; }
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/* `cond ? yes : no` in two parts, or null. Both branches are ways in, so the condition
   itself is never needed — and a `?.` or a `??` is not mistaken for one. */
function splitTernary(text) {
  let depth = 0;
  let quote = null;
  let nested = 0;
  let q = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    if (depth) continue;
    if (ch === '?' && text[i + 1] !== '?' && text[i + 1] !== '.') { if (q < 0) q = i; else nested++; }
    else if (ch === ':' && q >= 0) {
      if (nested) nested--;
      else return [text.slice(q + 1, i), text.slice(i + 1)];
    }
  }
  return null;
}

function stripParens(text) {
  let out = text;
  for (;;) {
    if (!out.startsWith('(') || !out.endsWith(')') || matchingClose(out, 0) !== out.length - 1) return out;
    out = out.slice(1, -1).trim();
  }
}

function unescapeLiteral(text) {
  return text.replace(/\\([\s\S])/g, function (all, c) {
    return c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c;
  });
}

/* Every value this expression can have, no duplicates, capped. */
function unionValues(a, b) {
  const out = a.slice();
  b.forEach(function (value) {
    if (out.indexOf(value) < 0 && out.length < MAX_VALUES_PER_NAME) out.push(value);
  });
  return out;
}

/* Every combination of the parts, capped, and NOTHING if any part is unknown: `'/a/' + x`
   is a page this check cannot name, and half a path is worse than none. */
function joinValues(groups) {
  let acc = [''];
  for (const values of groups) {
    if (!values.length) return [];
    const next = [];
    for (const a of acc) {
      for (const b of values) {
        if (next.length >= MAX_JOIN) break;
        next.push(a + b);
      }
    }
    acc = next;
    if (acc.length >= MAX_JOIN) break;
  }
  return acc;
}

/* The functions defined in this page, with their parameters, the expressions they return
   and the arguments their call sites pass. A function defined in another file has no body
   here to read, so it stays unknown. */
function collectFunctions(html) {
  const heads = [];
  const byName = {};
  const add = function (name, paramsText, braceAt) {
    const end = matchingClose(html, braceAt);
    if (end < 0) return;
    const head = {
      name: name, start: braceAt + 1, end: end, returns: [], calls: [],
      params: splitTop(paramsText, [',']).map(function (p) { return p.trim(); }).filter(Boolean)
    };
    heads.push(head);
    (byName[name] = byName[name] || []).push(head);
  };
  const HEADS = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g,
    /(?<![.\w$<-])([A-Za-z_$][\w$]*)\s*=\s*function\s*\(([^)]*)\)\s*\{/g,
    /(?<![.\w$<-])([A-Za-z_$][\w$]*)\s*=\s*\(([^)]*)\)\s*=>\s*\{/g
  ];
  HEADS.forEach(function (re) {
    let m;
    while ((m = re.exec(html)) !== null) add(m[1], m[2], m.index + m[0].length - 1);
  });
  /* A return belongs to the function it is innermost in, so a helper nested inside another
     function cannot hand its value to the outer one. */
  const ret = /\breturn\b/g;
  let m;
  while ((m = ret.exec(html)) !== null) {
    const read = readExpression(html, ret.lastIndex);
    if (!read.expr) continue;
    const owner = innermost(heads, m.index);
    if (owner) owner.returns.push(read.expr);
  }
  heads.forEach(function (head) { collectCallSites(html, head); });
  return { heads: heads, byName: byName };
}

/* The definition containing an offset, innermost first. */
function innermost(heads, offset) {
  let best = null;
  heads.forEach(function (head) {
    if (head.start <= offset && offset < head.end && (!best || head.start >= best.start)) best = head;
  });
  return best;
}

function collectCallSites(html, head) {
  const re = new RegExp('(?<![.\\w$])' + head.name + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(html)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchingClose(html, open);
    if (close < 0) continue;
    const before = html.slice(Math.max(0, m.index - 16), m.index);
    if (/(?:\bfunction|\bnew|\.|=)\s*$/.test(before)) continue;   // the definition itself
    head.calls.push({
      args: splitTop(html.slice(open + 1, close), [',']).map(function (a) { return a.trim(); })
    });
  }
}

/* `name = <expr>` for a plain name — not a property (`panel.src =`), not an attribute in
   markup (`<iframe src=`), not a comparison. */
function collectAssigned(html) {
  const assigned = {};
  const re = /(?<![.\w$<-])([A-Za-z_$][\w$]*)\s*=(?!=)\s*/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const read = readExpression(html, re.lastIndex);
    if (read.expr) (assigned[m[1]] = assigned[m[1]] || []).push(read.expr);
  }
  return assigned;
}

function resolvePage(html) {
  const page = { env: {}, funcs: collectFunctions(html) };
  const assigned = collectAssigned(html);
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    Object.keys(assigned).forEach(function (name) {
      assigned[name].forEach(function (expr) {
        page.env[name] = unionValues(page.env[name] || [], evalExpr(expr, page.env, page, 0));
      });
    });
  }
  return page;
}

function callValues(name, argsText, page, depth) {
  const defs = page.funcs.byName[name];
  if (!defs) return [];
  const args = splitTop(argsText, [',']).map(function (a) { return a.trim(); }).filter(Boolean);
  let out = [];
  defs.forEach(function (head) {
    if (!head.returns.length) return;
    const env = Object.assign({}, page.env);
    head.params.forEach(function (param, i) {
      if (i >= args.length) return;
      env[param] = unionValues(env[param] || [], evalExpr(args[i], env, page, depth));
    });
    head.returns.forEach(function (expr) { out = unionValues(out, evalExpr(expr, env, page, depth)); });
  });
  return out;
}

/* `a${x}b` — literal text around each interpolation, which is evaluated like any other
   expression; an interpolation that cannot be resolved makes the whole thing unknown. */
function templateValues(body, env, page, depth) {
  const groups = [];
  let text = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] === '\\') { text += unescapeLiteral(body.slice(i, i + 2)); i += 2; continue; }
    if (body[i] === '$' && body[i + 1] === '{') {
      const close = matchingClose(body, i + 1);
      if (close < 0) return [];
      groups.push([text]);
      text = '';
      groups.push(evalExpr(body.slice(i + 2, close), env, page, depth));
      i = close + 1;
      continue;
    }
    text += body[i++];
  }
  groups.push([text]);
  return joinValues(groups);
}

function evalExpr(expr, env, page, depth) {
  const text = stripParens(String(expr == null ? '' : expr).trim());
  if (!text || depth > MAX_CALL_DEPTH) return [];
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
  if (quoted) return [unescapeLiteral(quoted[2])];
  const template = /^`([\s\S]*)`$/.exec(text);
  if (template) return templateValues(template[1], env, page, depth);
  const branch = splitTernary(text);
  if (branch) {
    return unionValues(evalExpr(branch[0], env, page, depth), evalExpr(branch[1], env, page, depth));
  }
  const either = splitTop(text, ['||']);
  if (either.length > 1) {
    return either.reduce(function (acc, part) {
      return unionValues(acc, evalExpr(part, env, page, depth));
    }, []);
  }
  const plus = splitTop(text, ['+']);
  if (plus.length > 1) {
    return joinValues(plus.map(function (part) { return evalExpr(part, env, page, depth); }));
  }
  if (/^[A-Za-z_$][\w$]*$/.test(text)) return (env[text] || []).slice(0, MAX_VALUES_PER_NAME);
  const call = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(text);
  if (call) return callValues(call[1], call[2], page, depth + 1);
  return [];
}

/* One launch site, evaluated with the parameters of the function it sits in bound to the
   values that function's call sites pass — which is how a launcher that opens its own
   parameter is read. Outside any function, only the page's own names apply. */
function evalSite(expr, page, offset) {
  const head = innermost(page.funcs.heads, offset);
  if (!head) return evalExpr(expr, page.env, page, 0);
  const env = Object.assign({}, page.env);
  head.params.forEach(function (param, i) {
    head.calls.forEach(function (call) {
      if (i >= call.args.length) return;
      env[param] = unionValues(env[param] || [], evalExpr(call.args[i], page.env, page, 0));
    });
  });
  return evalExpr(expr, env, page, 0);
}



/* Addresses of pages, resolved against the launcher they came from and stripped of
   duplicates. Anything that is not a page — an anchor, a stylesheet, a video, an
   analytics beacon — is dropped before a single request goes out. The two lists feed the
   same filter, so a target written down and the same target computed are one way in and
   produce one entry. */
function launchTargets(html, pageUrl) {
  const out = [];
  const seen = {};
  const consider = function (raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text || /^(#|about:|javascript:|data:|mailto:|tel:)/i.test(text)) return;
    if (NON_PAGE.test(text)) return;
    let url;
    try { url = new URL(text, pageUrl); } catch (e) { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    url.hash = '';
    const key = url.toString();
    if (seen[key]) return;
    seen[key] = true;
    out.push(key);
  };

  LAUNCH_SOURCES.forEach(function (re) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html)) !== null) consider(m[1]);
  });

  /* The same sites again, but reading the whole expression and resolving it. Pages that
     hold no computed target cost a handful of regex passes and resolve to nothing. */
  const page = resolvePage(html);
  LAUNCH_EXPRESSIONS.forEach(function (re) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html)) !== null) {
      evalSite(readExpression(html, re.lastIndex).expr, page, m.index).forEach(consider);
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
