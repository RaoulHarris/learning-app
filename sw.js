// The service worker: keeps the app's own files so it opens offline.
//
// tools/publish_app.py fills in VERSION and FILES when it publishes. A new
// version is fetched whole (bypassing the HTTP cache) and replaces the old
// one the next time the app is opened. Unpublished ("dev") it caches nothing,
// so a local copy always runs the files as they are.
//
// Only the app's own files are handled here: calls to GitHub go straight
// to the network, and the subjects' files are kept by the app in IndexedDB.

const VERSION = '5b4fbb8b7d';
const FILES = [
  "./",
  "index.html",
  "app.css",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "src/data.js",
  "src/github.js",
  "src/local.js",
  "src/main.js",
  "src/render.js",
  "src/round.js",
  "src/sync.js",
  "src/version.js",
  "engine/ahead.js",
  "engine/brief.js",
  "engine/choose.js",
  "engine/index.js",
  "engine/questions.js",
  "engine/random.js",
  "engine/schedule.js",
  "engine/session.js",
  "engine/sha1.js",
  "engine/stats.js",
  "engine/store.js",
  "engine/strength.js",
  "engine/subject.js",
  "engine/summary.js",
  "engine/time.js",
  "engine/util.js",
  "vendor/mathjax/LICENSE",
  "vendor/mathjax/tex-svg-full.js"
];
const CACHE = `learn-${VERSION}`;

self.addEventListener('install', (event) => {
  if (VERSION === 'dev') {
    self.skipWaiting();
    return;
  }
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('learn-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (VERSION === 'dev') return;
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE)
    .then((cache) => cache.match(event.request, { ignoreSearch: true }))
    .then((hit) => hit || fetch(event.request)));
});
