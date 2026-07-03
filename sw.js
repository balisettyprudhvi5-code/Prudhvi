/* Smart Compress — Service Worker
   Network-first for index.html/navigations (so users always get the latest
   build instead of a stale cached shell), cache-first for static assets
   (icons, manifest, fonts, etc.), with an offline fallback to the last
   cached homepage. All image processing already happens 100% client-side,
   so this only needs to keep the shell itself available offline.

   Update flow: a new SW installs and caches assets, but deliberately does
   NOT call self.skipWaiting() automatically — it waits until the page
   explicitly asks it to (via a SKIP_WAITING message), which the page does
   after the user clicks "Update Now" on the update banner. This avoids
   yanking a user's in-progress compression/edit out from under them. */

const CACHE_NAME = "smartcompress-v4";

/* Only truly static, versioned-by-content-ish assets go here. index.html
   is deliberately excluded — it must never be served cache-first, since
   that's what was causing users to get stuck on old builds. */
const STATIC_ASSETS = [
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

const STATIC_EXTENSIONS = /\.(?:css|js|mjs|png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|otf|eot|webmanifest)$/i;

function isHtmlRequest(request, url) {
  return (
    request.mode === "navigate" ||
    (request.headers.get("accept") || "").includes("text/html") ||
    url.pathname === "/" ||
    url.pathname === "/index.html"
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .catch(() => { /* Missing individual assets shouldn't block install */ })
  );
  // Intentionally no self.skipWaiting() here — this build sits in the
  // "waiting" state until the page tells us to activate (see the
  // SKIP_WAITING message handler below), which lets the app show an
  // "Update available" banner instead of silently swapping code underneath
  // an in-progress task. The very first install (no prior controller) has
  // no old tab to disrupt, so the browser activates it right away regardless.
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Wipe every cache that isn't the current version — no stale caches
      // left behind from older deploys.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );

      // Take control of any already-open tabs immediately.
      await self.clients.claim();

      // Let every open tab know a new version just activated, so they can
      // react (e.g. reload) rather than silently keep running the old code.
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      allClients.forEach((client) => {
        client.postMessage({ type: "SW_UPDATED", version: CACHE_NAME });
      });
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  /* Only handle GET requests for our own origin — never intercept
     third-party scripts (Google Analytics, AdSense, fonts, CDNs) so
     they always behave exactly as they do today. */
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isHtmlRequest(request, url)) {
    // Network-first: always try to fetch the freshest index.html so users
    // never get stuck on an old cached version of the app shell. Only fall
    // back to the cache when the network is unavailable (offline support).
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", clone)).catch(() => {});
          return networkResponse;
        })
        .catch(() =>
          caches.match("/index.html").then((cached) => cached || caches.match("/"))
        )
    );
    return;
  }

  if (STATIC_EXTENSIONS.test(url.pathname)) {
    // Cache-first for static assets: fast, and fine to be a little stale
    // since a fresh index.html will pull in updated asset URLs whenever
    // they actually change.
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((networkResponse) => {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
            return networkResponse;
          })
          .catch(() => cached);
      })
    );
    return;
  }

  // Anything else same-origin: network-first with a cache fallback, same
  // as before.
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
        return networkResponse;
      })
      .catch(() => caches.match(request))
  );
});
