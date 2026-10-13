/*
 * Pack cache service worker — scope /game/.
 *
 * First visit: the pack (~330 MB) and engine files download once and are
 * stored in the Cache API while streaming to the page. Every visit after
 * that serves them from disk instantly — no re-download — while a cheap
 * HEAD request compares Content-Length in the background; when a new pack
 * ships (different size) the worker refetches once and the NEXT reload
 * plays it. The page also gets a 'vh-pack-updated' postMessage.
 *
 * The site-root sw.js (PWA install, pass-through) is untouched: this worker
 * only claims the /game/ scope, where the longest-scope rule makes it win.
 *
 * Failures degrade gracefully: any cache error falls back to plain network.
 */

/* The stub guard, shared with seblerskers/site-sw.js so the two copies of a check
   this load-bearing cannot drift. Relative to this worker's own URL, so it
   resolves to the site root from /game/ and from /seblerskers/ alike. If it
   cannot be loaded the worker throws here and the browser keeps the previous
   one — a worker running without the guard would play a 134-byte pointer as the
   game. A pack stub is an ordinary 200, which is why nothing else can catch it. */
self.PACK_GUARD_LABEL = 'over the ice';
importScripts('../pack-guard.js');

const CACHE = 'vh-game-v3';   // bumped 2026-09-28: drop any pointer-poisoned pack caches before the Pages-artifact pack ships
const PACK_MARKER = /index\.pck(\?|$)/;
// A versioned pack URL (?v=...) is a NEW pack by definition (the shell is
// re-shipped with a bumped version on every build) — never cache-first it.
// The bare URL keeps caching so repeat loads stay instant.
const PACK_UNCACHEABLE = /index\.pck\?/;
const BIG_FILE = /index\.pck|index\.wasm(\.gz)?$|index\.side\.wasm/;
const SMALL_FILE = /\.(js|png|ico|worklet\.js)$|index\.audio\./;

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    // drop caches from older worker versions
    const names = await caches.keys();
    await Promise.all(names.filter(function (n) { return n !== CACHE; })
      .map(function (n) { return caches.delete(n); }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // the HTML shell: network-first (so shell/patch updates land immediately),
  // cache fallback for offline
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }

  const isPack = PACK_MARKER.test(url.pathname + url.search) ||
    /index\.pck$/.test(url.pathname);
  const sameOrigin = url.origin === self.location.origin;
  const engineAsset = sameOrigin &&
    (BIG_FILE.test(url.pathname) || SMALL_FILE.test(url.pathname));

  if (!isPack && !engineAsset) return;   // everything else: browser native
  if (isPack && PACK_UNCACHEABLE.test(url.pathname + url.search)) return;

  event.respondWith(cacheFirst(req, isPack));
});

async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(CACHE);
    try { cache.put(req, fresh.clone()); } catch (e) { /* quota */ }
    return fresh;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(req, isPack) {
  const cache = await caches.open(CACHE);
  let cached = null;
  try { cached = await cache.match(req); } catch (e) { /* ignore */ }

  if (cached) {
    if (isPack) {
      /* A stub already under this key is dropped rather than served: returning
         it is how a poisoned entry reached the engine before the background
         revalidate could replace it, and the revalidate only fixes the NEXT
         visit. */
      const stubbed = stubByLength(cached);
      if (stubbed) {
        try { await cache.delete(req); } catch (e) { /* best effort */ }
        return stubbed;
      }
    }
    revalidate(req, cache, isPack);   // background, non-blocking
    return cached;
  }

  /* The head of the pack is always GDPC. A request for part of it is not, so
     only a fetch that starts at the beginning is checked for the magic; either
     way a stub is refused by name and never stored. */
  const partial = req.headers.has('range') &&
    !/^bytes=0-/.test(req.headers.get('range') || '');
  const fresh = isPack ? await guardPack(await fetch(req), !partial) : await fetch(req);
  if (isPack && fresh.status === 502) return fresh;
  // stream to the page AND keep a copy for next time
  try { await cache.put(req, fresh.clone()); } catch (e) { /* quota */ }
  return fresh;
}

/* HEAD the source and compare Content-Length against the cached copy.
   Different size => a new build ships => refetch once, replace the cache,
   tell open pages. No length / failed HEAD => keep what we have. */
async function revalidate(req, cache, isPack) {
  try {
    const head = await fetch(req.url, {
      method: 'HEAD', mode: 'cors', cache: 'no-store',
    });
    const len = head.headers.get('content-length');
    if (!len) return;
    const cachedLen = cachedLength(await cache.match(req));
    if (cachedLen === null || cachedLen === len) return;

    const fresh = await fetch(req.url, { mode: 'cors', cache: 'no-store' });
    if (!fresh.ok) return;
    await cache.put(req, fresh.clone());
    if (isPack) {
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach(function (c) {
        c.postMessage({ type: 'vh-pack-updated', size: Number(len) });
      });
    }
  } catch (e) { /* offline, CORS hiccup, quota — stay on the cached copy */ }
}

function cachedLength(resp) {
  if (!resp) return null;
  const h = resp.headers.get('content-length');
  return h ? String(Number(h)) : null;
}
