/* Smart Compress — Service Worker
   Cache-first for the app shell, network-first for everything else,
   with an offline fallback to the cached homepage. All image
   processing already happens 100% client-side, so this only needs
   to keep the shell itself available offline. */

const CACHE_NAME = "smart-compress-v1.5.0";

const APP_SHELL = [
  "/",
  "/index.html",
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-192-maskable.png",
  "/icon-512-maskable.png",
  "/logo-icon.png",
  "/site.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => { /* Missing individual assets shouldn't block install */ })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  /* Only handle GET requests for our own origin — never intercept
     third-party scripts (Google Analytics, AdSense, fonts, CDNs) so
     they always behave exactly as they do today. */
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
        return networkResponse;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || caches.match("/index.html"))
      )
  );
});
