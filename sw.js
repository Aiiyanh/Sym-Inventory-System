/* ═══════════════════════════════════════════════════════
   SERVICE WORKER — Sol Mar Inventory PWA
   Strategy:
   - App shell (HTML/CSS/JS/icons) → cache-first, so the app opens
     instantly and works offline even with no signal.
   - Everything else (Firestore calls, Google Fonts, Chart.js CDN)
     → network-first, since inventory data must never be served stale
     when a connection is available. Firestore's own SDK already
     handles offline queuing/sync for the actual data writes.
   Bump CACHE_VERSION whenever app-shell files change, so returning
   devices pick up the new version instead of a stale cached one.
═══════════════════════════════════════════════════════ */
const CACHE_VERSION = 'solmar-inventory-v1';
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
      url.hostname.includes('gstatic.com') && !url.pathname.includes('firebasejs')) {
    return;
  }

  const isAppShellFile = APP_SHELL.some(path => url.pathname.endsWith(path.replace('./', '/')) || (path === './' && url.pathname === '/'));

  if (isAppShellFile) {
    // Cache-first for the app shell — instant load, works offline.
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req))
    );
  } else {
    // Network-first for everything else (CDN libs, fonts) with cache fallback.
    event.respondWith(
      fetch(req)
        .then(res => {
          const resClone = res.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(req, resClone));
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
