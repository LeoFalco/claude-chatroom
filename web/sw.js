// Service worker: makes the app installable and lets its shell open offline.
// Chat data is not cached here; Firestore handles that.
// - App files: network first (updates show up right away), cache as fallback.
// - Firebase SDK from gstatic: versioned URLs, so cache first.
// - Everything else (Firestore, Auth, Google sign-in): straight to the network.

const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const SDK_CACHE = `sdk-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'app.js',
  'config.js',
  'style.css',
  'favicon.svg',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];
const SDK_PREFIX = 'https://www.gstatic.com/firebasejs/';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== SDK_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.href.startsWith(SDK_PREFIX)) {
    event.respondWith(cacheFirst(req, SDK_CACHE));
    return;
  }
  // Same-origin app files only; Firebase's /__/ endpoints (auth handler, init.json) stay live.
  if (url.origin === self.location.origin && !url.pathname.startsWith('/__/')) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
  }
});

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) (await caches.open(cacheName)).put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(cacheName)).put(req, res.clone());
    return res;
  } catch (err) {
    const cached = (await caches.match(req, { ignoreSearch: true })) ?? (req.mode === 'navigate' ? await caches.match('index.html') : null);
    if (cached) return cached;
    throw err;
  }
}
