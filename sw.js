/*
 * Minimal service worker — exists ONLY to make anthonitus.com installable
 * (a PWA), which is Chrome's official unlock for first-entry audio
 * autoplay. It caches NOTHING and never touches the network: every request
 * passes straight through, so it cannot serve stale pages or interfere
 * with the game pack. If it ever goes missing, installs keep working.
 */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function () {
  /* pass-through: let the browser handle every request natively */
});
