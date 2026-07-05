/* ============================================================
   Smart Compress — Service Worker
   ------------------------------------------------------------
   IMPORTANT: Bump CACHE_VERSION on every single deployment.
   Changing this number (even by 1) changes the byte content of
   this file, which is what makes browsers detect a new
   deployment automatically (the browser's SW update algorithm
   byte-compares sw.js on every navigation/every ~24h).
   Keep this number in sync with window.APP_VERSION in index.html
   (used only for the human-readable display in Settings).
   ============================================================ */
const CACHE_VERSION = 1;
const CACHE_NAME = `smartcompress-v${CACHE_VERSION}`;

/* Only pre-cache the app shell. Everything else is cached
   on-the-fly as it's requested (runtime caching below). */
const APP_SHELL = [
  "/",
  "/index.html",
  "/offline.html",
  "/site.webmanifest"
];

/* ---------------- INSTALL ----------------
   Pre-cache the app shell, then immediately move to "waiting"
   state until the page tells us to activate (see message
   listener below) — this lets index.html show an update toast
   and control exactly when the reload happens instead of
   silently swapping content under the user. */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch(() => { /* ignore individual failures, e.g. offline.html not deployed yet */ })
        )
      );
    })
  );
});

/* ---------------- ACTIVATE ----------------
   Delete every cache that isn't the current version, then take
   control of all open tabs immediately. */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith("smartcompress-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

/* ---------------- MESSAGE ----------------
   Allows the page to tell a waiting worker to activate now
   (used by the "Refresh" button in the update toast). */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

/* ---------------- FETCH ----------------
   Strategy:
   - HTML / navigation requests: network-first, falling back to
     cache, then to offline.html. This guarantees the freshest
     index.html is always served when the device is online,
     which is the root fix for the "only works in Incognito"
     stale-HTML problem.
   - Static assets (images, fonts, css, js): cache-first, then
     network, and cache the network response for next time so
     the site still works fully offline.
*/
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  const isHTMLRequest =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isHTMLRequest) {
    event.respondWith(
      fetch(req, { cache: "no-store" })
        .then((networkResponse) => {
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return networkResponse;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match("/offline.html"))
        )
    );
    return;
  }

  if (isSameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const networkFetch = fetch(req)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const copy = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
            }
            return networkResponse;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
  /* Cross-origin requests (fonts.googleapis.com, cdnjs, adsense, etc.)
     are left to the browser's normal HTTP cache — we don't intercept
     third-party requests. */
});
