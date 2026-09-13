/*
 * Tiny Home PWA service worker — exists ONLY to make the app installable.
 * Caches NOTHING: every request passes straight through (same pattern as
 * the site root sw.js), so it can never serve stale content.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* pass-through */ });
