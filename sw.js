/* ═══════════════════════════════════════════════════════
   SERVICE WORKER — Sol Mar Inventory PWA
   Strategy: network-first for everything, with a cache fallback
   for offline use.
   Previously the app shell (HTML/CSS/JS) used cache-first, which
   caused a real bug: after deploying an update, returning users
   (e.g. logging out then back in — just a page reload) kept seeing
   the OLD cached version until they did a manual hard-refresh,
   because cache-first never re-checks the network once something
   is cached. Network-first fixes that — whenever there's a
   connection, the latest deployed files are always fetched, and
   the cache is only used as a fallback when actually offline.
   Bump CACHE_VERSION on major changes to force-clear old caches.
═══════════════════════════════════════════════════════ */
const CACHE_VERSION = 'solmar-inventory-v2';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app-firebase.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_VERSION)
            .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept Firestore/Google API traffic — let the Firestore SDK's
  // own offline persistence handle that, so this SW doesn't fight it.
  if (url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('googleapis.com') ||
      (url.hostname.includes('gstatic.com') && !url.pathname.includes('firebasejs'))) {
    return;
  }

  // Network-first, cache fallback — for the app shell AND everything else.
  // Ensures logging out/in (a plain reload) always gets the latest deployed
  // code when online, while still working offline from the last-cached copy.
  event.respondWith(
    fetch(req)
      .then(res => {
        const resClone = res.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(req, resClone));
        return res;
      })
      .catch(() => caches.match(req))
  );
});