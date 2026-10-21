/* Offline shell for Vita Hueso Radio.
 * Caches the interface (HTML/CSS/JS) — never the MP3s, so audio keeps
 * streaming normally and the cache stays small. */
const VERSION = 'vh-radio-v1';
const CORE = [
  './',
  './index.html',
  './embed.html',
  './css/station.css',
  './js/config.js',
  './js/catalog.js',
  './js/station.js',
  './js/player.js',
  './js/visualizer.js',
  './js/community.js',
  './js/ui.js',
  './assets/favicon.svg',
  './assets/art/t01.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (request.headers.has('range') || /\.(mp3|webm|wav|ogg|m4a)$/i.test(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
