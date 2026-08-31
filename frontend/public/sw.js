// sw.js
// Minimal service worker - its only real job is to exist and control the
// page, which is one of the browser's requirements for "installable" (the
// Android/Chrome install prompt won't fire without one registered). Uses a
// light network-first strategy so the app always gets fresh data/logic
// when online, with a very small fallback cache for true offline cases
// (e.g. opening the app with no signal) rather than a full offline mode -
// this is a WhatsApp-dependent, server-backed app, so deep offline support
// isn't a realistic goal here.

const CACHE_NAME = 'elimu-smart-shell-v1';
const SHELL_FILES = ['/admin.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests - everything else (API calls to
  // Render, Firebase Auth, WhatsApp links) passes straight through untouched.
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
